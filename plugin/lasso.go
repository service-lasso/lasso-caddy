// Package lassoconfig provides the Service Lasso admin API extension for Caddy.
//
// It lets Service Lasso register and unregister upstream application packages
// (FastCGI backends such as Nextcloud, or plain HTTP backends) with simplified
// JSON payloads, instead of compiling full Caddy route trees on the client side.
//
// The module is loaded into Caddy's admin API under the admin.api.lasso module
// id and exposes two endpoints on the admin listener:
//
//	POST /service-lasso/register
//	POST /service-lasso/unregister
//
// Registration mutates the managed HTTP server (lasso_ingress): it points the
// server listener at the dynamically allocated ingress port and injects or
// replaces a host-matched route whose upstream is the project's dynamic target
// port. The running configuration is reloaded in place with caddy.Load, giving a
// zero-downtime hot swap. If loading fails, the previous routing state is kept.
package lassoconfig

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/caddyserver/caddy/v2"
	"go.uber.org/zap"
)

const (
	// serverName is the HTTP server managed by this extension.
	serverName = "lasso_ingress"
	// routeIDPrefix namespaces the @id values owned by this extension.
	routeIDPrefix = "lasso:"
	// defaultAdminAddress is used only if the incoming request has no Host.
	defaultAdminAddress = "localhost:2019"
)

func init() {
	caddy.RegisterModule(LassoAdminEndpoint{})
}

// LassoAdminEndpoint implements caddy.AdminRouter. It is the host for the
// /service-lasso/* admin endpoints.
type LassoAdminEndpoint struct {
	logger *zap.Logger
}

// CaddyModule returns the Caddy module information.
func (LassoAdminEndpoint) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "admin.api.lasso",
		New: func() caddy.Module { return new(LassoAdminEndpoint) },
	}
}

// Provision sets up the module.
func (l *LassoAdminEndpoint) Provision(ctx caddy.Context) error {
	l.logger = ctx.Logger()
	return nil
}

func (l *LassoAdminEndpoint) log() *zap.Logger {
	if l.logger != nil {
		return l.logger
	}
	return caddy.Log().Named("admin.api.lasso")
}

// Routes returns the admin API routes owned by the extension.
func (l *LassoAdminEndpoint) Routes() []caddy.AdminRoute {
	return []caddy.AdminRoute{
		{Pattern: "/service-lasso/register", Handler: caddy.AdminHandlerFunc(l.handleRegister)},
		{Pattern: "/service-lasso/unregister", Handler: caddy.AdminHandlerFunc(l.handleUnregister)},
	}
}

// RegisterPayload is the request body for /service-lasso/register.
type RegisterPayload struct {
	ID          string `json:"id"`
	Domain      string `json:"domain"`
	IngressPort int    `json:"ingress_port"`
	Type        string `json:"type"`
	Target      string `json:"target"`
	Root        string `json:"root,omitempty"`
}

// UnregisterPayload is the request body for /service-lasso/unregister.
type UnregisterPayload struct {
	ID string `json:"id"`
}

// mu serialises read-modify-write cycles so concurrent registrations cannot race.
var mu sync.Mutex

func (l *LassoAdminEndpoint) handleRegister(w http.ResponseWriter, r *http.Request) error {
	if r.Method != http.MethodPost {
		return apiError(http.StatusMethodNotAllowed, "only POST is supported")
	}

	var payload RegisterPayload
	if err := decodeJSON(r, &payload); err != nil {
		return apiError(http.StatusBadRequest, err.Error())
	}
	if err := payload.validate(); err != nil {
		return apiError(http.StatusBadRequest, err.Error())
	}

	mu.Lock()
	defer mu.Unlock()

	l.log().Info("register request", zap.String("id", payload.ID), zap.String("domain", payload.Domain), zap.Int("ingress_port", payload.IngressPort), zap.String("type", payload.Type))

	if err := l.mutate(r, func(root map[string]any) error { return mutateAdd(root, payload) }); err != nil {
		return err
	}

	writeJSON(w, http.StatusOK, statusResponse{Status: "success"})
	return nil
}

func (l *LassoAdminEndpoint) handleUnregister(w http.ResponseWriter, r *http.Request) error {
	if r.Method != http.MethodPost {
		return apiError(http.StatusMethodNotAllowed, "only POST is supported")
	}

	var payload UnregisterPayload
	if err := decodeJSON(r, &payload); err != nil {
		return apiError(http.StatusBadRequest, err.Error())
	}
	if strings.TrimSpace(payload.ID) == "" {
		return apiError(http.StatusBadRequest, "id is required")
	}

	mu.Lock()
	defer mu.Unlock()

	if err := l.mutate(r, func(root map[string]any) error { return mutateRemove(root, payload.ID) }); err != nil {
		return err
	}

	writeJSON(w, http.StatusOK, statusResponse{Status: "success"})
	return nil
}

// mutate reads the running config, applies fn, then atomically loads the result.
// If loading is rejected the previous routing state is preserved (fail-closed).
func (l *LassoAdminEndpoint) mutate(r *http.Request, fn func(root map[string]any) error) error {
	l.log().Info("reading running config")
	raw, err := l.readConfig(r)
	if err != nil {
		return apiError(http.StatusInternalServerError, "failed to read running config: "+err.Error())
	}
	l.log().Info("read running config", zap.Int("bytes", len(raw)))

	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return apiError(http.StatusInternalServerError, "running config is not valid JSON: "+err.Error())
	}

	if err := fn(root); err != nil {
		return apiError(http.StatusUnprocessableEntity, "mutation failed: "+err.Error())
	}

	out, err := json.Marshal(root)
	if err != nil {
		return apiError(http.StatusInternalServerError, "failed to encode config: "+err.Error())
	}
	l.log().Info("loading mutated config")
	if err := caddy.Load(out, true); err != nil {
		return apiError(http.StatusInternalServerError, "config load rejected: "+err.Error())
	}
	l.log().Info("loaded mutated config")
	return nil
}

// readConfig fetches the currently running config from the admin API. The admin
// listener this handler is running on is derived from the incoming request Host.
func (l *LassoAdminEndpoint) readConfig(r *http.Request) ([]byte, error) {
	host := r.Host
	if host == "" {
		host = defaultAdminAddress
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, "http://"+host+"/config/", nil)
	if err != nil {
		return nil, err
	}
	req.Host = host

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("admin config endpoint returned status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func (p RegisterPayload) validate() error {
	if strings.TrimSpace(p.ID) == "" {
		return errors.New("id is required")
	}
	if strings.TrimSpace(p.Domain) == "" {
		return errors.New("domain is required")
	}
	if p.IngressPort <= 0 || p.IngressPort > 65535 {
		return fmt.Errorf("ingress_port must be a valid TCP port, got %d", p.IngressPort)
	}
	if strings.TrimSpace(p.Target) == "" {
		return errors.New("target is required")
	}
	switch p.Type {
	case "fastcgi":
		if strings.TrimSpace(p.Root) == "" {
			return errors.New("root is required for fastcgi services")
		}
	case "http":
	default:
		return fmt.Errorf("type must be \"fastcgi\" or \"http\", got %q", p.Type)
	}
	return nil
}

// mutateAdd injects or replaces the route for payload.ID (keyed by @id) and
// points the managed server listener at payload.IngressPort.
func mutateAdd(root map[string]any, payload RegisterPayload) error {
	server, err := ensureServer(root)
	if err != nil {
		return err
	}

	// The translator serves plain HTTP to the local router; TLS is terminated
	// upstream. Disabling automatic HTTPS prevents Caddy from provisioning
	// certificates (and attempting to install a local root CA) when a
	// host-matched route is added.
	server["automatic_https"] = map[string]any{"disable": true}
	// Bind loopback only: the local router reaches Caddy over 127.0.0.1, and a
	// non-loopback listen would make Windows Firewall prompt on every start.
	server["listen"] = []any{fmt.Sprintf("127.0.0.1:%d", payload.IngressPort)}

	routes, _ := server["routes"].([]any)
	route := buildRoute(payload)
	id := routeIDPrefix + payload.ID

	replaced := false
	for i, existing := range routes {
		if existingRouteID(existing) == id {
			routes[i] = route
			replaced = true
			break
		}
	}
	if !replaced {
		routes = append(routes, route)
	}
	server["routes"] = routes
	return nil
}

// mutateRemove removes the route for id, if present.
func mutateRemove(root map[string]any, id string) error {
	server, err := ensureServer(root)
	if err != nil {
		return err
	}

	routes, _ := server["routes"].([]any)
	target := routeIDPrefix + id
	filtered := make([]any, 0, len(routes))
	for _, existing := range routes {
		if existingRouteID(existing) == target {
			continue
		}
		filtered = append(filtered, existing)
	}
	server["routes"] = filtered
	return nil
}

func buildRoute(payload RegisterPayload) map[string]any {
	return map[string]any{
		"@id":    routeIDPrefix + payload.ID,
		"match":  []any{map[string]any{"host": []any{payload.Domain}}},
		"handle": []any{buildHandler(payload)},
	}
}

func buildHandler(payload RegisterPayload) map[string]any {
	handler := map[string]any{
		"handler":   "reverse_proxy",
		"upstreams": []any{map[string]any{"dial": payload.Target}},
	}
	if payload.Type == "fastcgi" {
		handler["transport"] = map[string]any{
			"protocol":   "fastcgi",
			"root":       payload.Root,
			"split_path": []any{".php"},
		}
	}
	return handler
}

func existingRouteID(route any) string {
	obj, ok := route.(map[string]any)
	if !ok {
		return ""
	}
	id, _ := obj["@id"].(string)
	return id
}

// ensureServer returns apps.http.servers[serverName], creating the path if needed.
func ensureServer(root map[string]any) (map[string]any, error) {
	apps, err := ensureMap(root, "apps")
	if err != nil {
		return nil, err
	}
	httpApp, err := ensureMap(apps, "http")
	if err != nil {
		return nil, err
	}
	servers, err := ensureMap(httpApp, "servers")
	if err != nil {
		return nil, err
	}
	return ensureMap(servers, serverName)
}

func ensureMap(parent map[string]any, key string) (map[string]any, error) {
	if existing, ok := parent[key]; ok {
		typed, ok := existing.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("config key %q is not an object", key)
		}
		return typed, nil
	}
	created := map[string]any{}
	parent[key] = created
	return created, nil
}

type statusResponse struct {
	Status string `json:"status"`
}

func decodeJSON(r *http.Request, dst any) error {
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(dst); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func apiError(status int, message string) error {
	return caddy.APIError{HTTPStatus: status, Err: errors.New(message), Message: message}
}

// Interface guards.
var (
	_ caddy.Module      = (*LassoAdminEndpoint)(nil)
	_ caddy.Provisioner = (*LassoAdminEndpoint)(nil)
	_ caddy.AdminRouter = (*LassoAdminEndpoint)(nil)
)
