// HealthCheck implementa o subcomando "health" dos binários. A imagem é FROM scratch (sem shell nem curl),
// então o HEALTHCHECK do Docker chama o próprio binário, que faz GET em 127.0.0.1 na porta de ADDR

package bizas

import (
	"fmt"
	"net"
	"net/http"
	"time"
)

// HealthURL devolve http://127.0.0.1:<porta de addr>/health
func HealthURL(addr string) (string, error) {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", fmt.Errorf("ADDR %q: %w", addr, err)
	}
	return "http://127.0.0.1:" + port + "/health", nil
}

// HealthCheck devolve 0 se /health respondeu 200 em até 1 s, ou 1
func HealthCheck(addr string) int {
	url, err := HealthURL(addr)
	if err != nil {
		fmt.Println(err)
		return 1
	}
	c := http.Client{Timeout: time.Second}
	resp, err := c.Get(url)
	if err != nil {
		fmt.Println(err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Println(url, resp.Status)
		return 1
	}
	return 0
}
