package lassoconfig

import (
	"encoding/json"
	"testing"
)

func baseConfig(t *testing.T) map[string]any {
	t.Helper()
	var root map[string]any
	raw := []byte(`{
		"admin": {"listen": "127.0.0.1:2019"},
		"apps": {
			"http": {
				"servers": {
					"lasso_ingress": {
						"listen": [":8080"],
						"routes": [
							{"@id": "lasso:health", "handle": [{"handler": "static_response", "body": "ok"}]}
						]
					}
				}
			}
		}
	}`)
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatalf("unmarshal base config: %v", err)
	}
	return root
}

func server(t *testing.T, root map[string]any) map[string]any {
	t.Helper()
	srv, err := ensureServer(root)
	if err != nil {
		t.Fatalf("ensureServer: %v", err)
	}
	return srv
}

func routes(t *testing.T, srv map[string]any) []any {
	t.Helper()
	rs, _ := srv["routes"].([]any)
	return rs
}

func TestMutateAddCreatesRouteAndListen(t *testing.T) {
	root := baseConfig(t)
	payload := RegisterPayload{
		ID:          "@nextcloud",
		Domain:      "nextcloud.servicelasso.localhost",
		IngressPort: 50123,
		Type:        "fastcgi",
		Target:      "127.0.0.1:61124",
		Root:        "/srv/nextcloud",
	}

	if err := mutateAdd(root, payload); err != nil {
		t.Fatalf("mutateAdd: %v", err)
	}

	srv := server(t, root)
	listen, _ := srv["listen"].([]any)
	if len(listen) != 1 || listen[0] != "127.0.0.1:50123" {
		t.Fatalf("listen = %v, want [\"127.0.0.1:50123\"]", listen)
	}

	rs := routes(t, srv)
	if len(rs) != 2 {
		t.Fatalf("routes length = %d, want 2 (health + nextcloud)", len(rs))
	}

	added := rs[1].(map[string]any)
	if added["@id"] != "lasso:@nextcloud" {
		t.Fatalf("route @id = %v", added["@id"])
	}
	match := added["match"].([]any)[0].(map[string]any)
	hosts := match["host"].([]any)
	if len(hosts) != 1 || hosts[0] != "nextcloud.servicelasso.localhost" {
		t.Fatalf("hosts = %v", hosts)
	}

	handler := added["handle"].([]any)[0].(map[string]any)
	if handler["handler"] != "reverse_proxy" {
		t.Fatalf("handler = %v", handler["handler"])
	}
	upstream := handler["upstreams"].([]any)[0].(map[string]any)
	if upstream["dial"] != "127.0.0.1:61124" {
		t.Fatalf("upstream dial = %v", upstream["dial"])
	}
	transport, ok := handler["transport"].(map[string]any)
	if !ok || transport["protocol"] != "fastcgi" {
		t.Fatalf("transport = %v", handler["transport"])
	}
	if transport["root"] != "/srv/nextcloud" {
		t.Fatalf("fastcgi root = %v", transport["root"])
	}
}

func TestMutateAddHttpHasNoTransport(t *testing.T) {
	root := baseConfig(t)
	payload := RegisterPayload{
		ID:          "@node-app",
		Domain:      "app.servicelasso.localhost",
		IngressPort: 50124,
		Type:        "http",
		Target:      "127.0.0.1:3000",
	}
	if err := mutateAdd(root, payload); err != nil {
		t.Fatalf("mutateAdd: %v", err)
	}
	rs := routes(t, server(t, root))
	handler := rs[len(rs)-1].(map[string]any)["handle"].([]any)[0].(map[string]any)
	if _, hasTransport := handler["transport"]; hasTransport {
		t.Fatalf("http handler must not declare a transport: %v", handler)
	}
}

func TestMutateAddIsIdempotent(t *testing.T) {
	root := baseConfig(t)
	payload := RegisterPayload{
		ID:          "@nextcloud",
		Domain:      "nextcloud.servicelasso.localhost",
		IngressPort: 50123,
		Type:        "fastcgi",
		Target:      "127.0.0.1:61124",
		Root:        "/srv/nextcloud",
	}

	for i := 0; i < 3; i++ {
		if err := mutateAdd(root, payload); err != nil {
			t.Fatalf("mutateAdd #%d: %v", i, err)
		}
	}

	rs := routes(t, server(t, root))
	if len(rs) != 2 {
		t.Fatalf("routes length = %d, want 2 after repeated registration", len(rs))
	}
}

func TestMutateAddUpdatesRouteInPlace(t *testing.T) {
	root := baseConfig(t)
	first := RegisterPayload{ID: "@nextcloud", Domain: "a.localhost", IngressPort: 50123, Type: "http", Target: "127.0.0.1:1111"}
	second := RegisterPayload{ID: "@nextcloud", Domain: "b.localhost", IngressPort: 50456, Type: "http", Target: "127.0.0.1:2222"}

	if err := mutateAdd(root, first); err != nil {
		t.Fatalf("mutateAdd first: %v", err)
	}
	if err := mutateAdd(root, second); err != nil {
		t.Fatalf("mutateAdd second: %v", err)
	}

	srv := server(t, root)
	listen, _ := srv["listen"].([]any)
	if listen[0] != "127.0.0.1:50456" {
		t.Fatalf("listen = %v, want [\"127.0.0.1:50456\"]", listen)
	}
	rs := routes(t, srv)
	if len(rs) != 2 {
		t.Fatalf("routes length = %d, want 2", len(rs))
	}
	route := rs[1].(map[string]any)
	hosts := route["match"].([]any)[0].(map[string]any)["host"].([]any)
	if hosts[0] != "b.localhost" {
		t.Fatalf("hosts = %v, want updated b.localhost", hosts)
	}
	dial := route["handle"].([]any)[0].(map[string]any)["upstreams"].([]any)[0].(map[string]any)["dial"]
	if dial != "127.0.0.1:2222" {
		t.Fatalf("dial = %v, want updated target", dial)
	}
}

func TestMutateRemove(t *testing.T) {
	root := baseConfig(t)
	payload := RegisterPayload{ID: "@nextcloud", Domain: "nextcloud.servicelasso.localhost", IngressPort: 50123, Type: "http", Target: "127.0.0.1:61124"}
	if err := mutateAdd(root, payload); err != nil {
		t.Fatalf("mutateAdd: %v", err)
	}
	if err := mutateRemove(root, "@nextcloud"); err != nil {
		t.Fatalf("mutateRemove: %v", err)
	}
	rs := routes(t, server(t, root))
	if len(rs) != 1 {
		t.Fatalf("routes length = %d, want 1 (health only)", len(rs))
	}
	if existingRouteID(rs[0]) != "lasso:health" {
		t.Fatalf("remaining route id = %v, want lasso:health", existingRouteID(rs[0]))
	}
}

func TestMutateRemoveMissingIsNoop(t *testing.T) {
	root := baseConfig(t)
	if err := mutateRemove(root, "@absent"); err != nil {
		t.Fatalf("mutateRemove: %v", err)
	}
	if len(routes(t, server(t, root))) != 1 {
		t.Fatalf("removing an absent id must not change routes")
	}
}

func TestMutateAddRejectsNonObjectConfigPath(t *testing.T) {
	root := map[string]any{"apps": "not-an-object"}
	err := mutateAdd(root, RegisterPayload{ID: "@x", Domain: "x.localhost", IngressPort: 1, Type: "http", Target: "127.0.0.1:1"})
	if err == nil {
		t.Fatal("expected error for non-object apps path")
	}
}

func TestRegisterPayloadValidate(t *testing.T) {
	cases := []struct {
		name    string
		payload RegisterPayload
		wantErr bool
	}{
		{"valid fastcgi", RegisterPayload{ID: "@nc", Domain: "d", IngressPort: 1, Type: "fastcgi", Target: "t", Root: "/r"}, false},
		{"valid http", RegisterPayload{ID: "@nc", Domain: "d", IngressPort: 1, Type: "http", Target: "t"}, false},
		{"missing id", RegisterPayload{Domain: "d", IngressPort: 1, Type: "http", Target: "t"}, true},
		{"missing domain", RegisterPayload{ID: "@nc", IngressPort: 1, Type: "http", Target: "t"}, true},
		{"bad port", RegisterPayload{ID: "@nc", Domain: "d", IngressPort: 0, Type: "http", Target: "t"}, true},
		{"bad type", RegisterPayload{ID: "@nc", Domain: "d", IngressPort: 1, Type: "ws", Target: "t"}, true},
		{"fastcgi missing root", RegisterPayload{ID: "@nc", Domain: "d", IngressPort: 1, Type: "fastcgi", Target: "t"}, true},
		{"missing target", RegisterPayload{ID: "@nc", Domain: "d", IngressPort: 1, Type: "http"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.payload.validate()
			if tc.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
