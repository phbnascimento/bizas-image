// Comando server: página, WebSocket e repasse ao validator
//
//	server                                       sobe a página (ADDR, padrão :5000) e a porta de manutenção
//	                                             (ADMIN_ADDR, padrão 127.0.0.1:5001, só loopback)
//	server health                                HEALTHCHECK do Docker: 0 se /health responde 200
//	server set-date YYYY-MM-DD-hh-mm-ss [--tz Z] informa a hora real, para a página mostrar datas (fuso padrão UTC)
//	server set-auto-date                         consulta a hora real na rede (SNTP) e a informa
//
// set-date e set-auto-date rodam dentro do container (docker exec) e falam com a porta de manutenção dele
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/phbnascimento/bizas-image/application/bizas"
)

const usage = "usage: server [health | set-date YYYY-MM-DD-hh-mm-ss [--tz ZONE] | set-auto-date]"

func main() {
	addr := env("ADDR", ":5000")
	adminAddr := env("ADMIN_ADDR", "127.0.0.1:5001")
	if len(os.Args) > 1 {
		switch {
		case os.Args[1] == "health" && len(os.Args) == 2:
			// Passa pelo /health do server, que só dá 200 com o validator de pé
			os.Exit(bizas.HealthCheck(addr))
		case os.Args[1] == "set-date":
			value, zone, err := ParseSetDateArgs(os.Args[2:])
			if err != nil {
				fmt.Fprintln(os.Stderr, "set-date:", err)
				fmt.Fprintln(os.Stderr, usage)
				os.Exit(2)
			}
			t, err := ParseSetDate(value, zone)
			if err != nil {
				fmt.Fprintln(os.Stderr, "set-date:", err)
				os.Exit(2)
			}
			os.Exit(sendClock(adminAddr, t, "set-date"))
		case os.Args[1] == "set-auto-date" && len(os.Args) == 2:
			t, err := AutoDate(NTPServers, 3*time.Second)
			if err != nil {
				fmt.Fprintln(os.Stderr, "set-auto-date:", err)
				os.Exit(1)
			}
			os.Exit(sendClock(adminAddr, t, "set-auto-date"))
		}
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	validatorURL := env("VALIDATOR_URL", "http://validator:8081")

	// A porta de manutenção muda a hora mostrada a todos: nunca pode escutar fora do loopback do container
	if err := requireLoopback(adminAddr); err != nil {
		log.Error("refusing to start", "err", err)
		os.Exit(1)
	}

	s := New(validatorURL, log)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := s.WaitValidator(ctx); err != nil {
			log.Warn("validator did not answer within 1 min", "url", validatorURL, "err", err)
			return
		}
		log.Info("validator answered", "url", validatorURL)
	}()
	go func() {
		if err := http.ListenAndServe(adminAddr, s.AdminHandler()); err != nil {
			log.Error("admin listener failed", "addr", adminAddr, "err", err)
			os.Exit(1)
		}
	}()

	log.Info("server listening", "addr", addr, "admin", adminAddr, "validator", validatorURL)
	if err := http.ListenAndServe(addr, s.Handler(Static())); err != nil {
		log.Error("failed", "err", err)
		os.Exit(1)
	}
}

func requireLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("ADMIN_ADDR %q: %w", addr, err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("ADMIN_ADDR %q is not a loopback address", addr)
	}
	return nil
}

// sendClock informa a hora real à porta de manutenção. Devolve o código de saída
func sendClock(adminAddr string, real time.Time, cmd string) int {
	c := http.Client{Timeout: 5 * time.Second}
	resp, err := c.Post("http://"+adminAddr+"/clock", "text/plain", strings.NewReader(strconv.FormatInt(real.UnixNano(), 10)))
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: the server is not answering on %s: %v\n", cmd, adminAddr, err)
		return 1
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "%s: %s: %s", cmd, resp.Status, body)
		return 1
	}
	fmt.Printf("%s: %s", cmd, body)
	return 0
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
