package bizas

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthURL(t *testing.T) {
	for addr, want := range map[string]string{
		":5000":        "http://127.0.0.1:5000/health",
		"0.0.0.0:8081": "http://127.0.0.1:8081/health",
	} {
		if got, err := HealthURL(addr); err != nil || got != want {
			t.Errorf("HealthURL(%q) = %q, %v", addr, got, err)
		}
	}
	if _, err := HealthURL("5000"); err == nil {
		t.Error("accepted ADDR without ':'")
	}
}

func TestHealthCheck(t *testing.T) {
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
	}))
	defer srv.Close()
	addr := srv.Listener.Addr().String()
	if !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Skip("httptest not on 127.0.0.1")
	}
	if rc := HealthCheck(addr); rc != 0 {
		t.Fatalf("200 gave rc=%d", rc)
	}
	status = http.StatusServiceUnavailable
	if rc := HealthCheck(addr); rc != 1 {
		t.Fatalf("503 gave rc=%d", rc)
	}
	srv.Close()
	if rc := HealthCheck(addr); rc != 1 {
		t.Fatalf("server down gave rc=%d", rc)
	}
}
