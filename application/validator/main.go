// Comando validator: dono da cadeia, sem porta no host (só a rede Docker)
//
//	validator                                 sobe a API interna (ADDR, padrão :8081; a cadeia fica em
//	                                          DATA_DIR/chain.bin, padrão /data)
//	validator health                          HEALTHCHECK do Docker: 0 se /health responde 200
//	validator verify <chain.bin>              confere uma cadeia baixada de /chain, sem a Pi
//	validator fingerprint <chain.bin> [N]     impressão digital da cadeia na altura N (padrão: a cabeça)
package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/phbnascimento/bizas-image/application/bizas"
)

const usage = "usage: validator [health | verify <chain.bin> | fingerprint <chain.bin> [height]]"

func main() {
	addr := env("ADDR", ":8081")
	if len(os.Args) > 1 {
		switch {
		case os.Args[1] == "health" && len(os.Args) == 2:
			os.Exit(bizas.HealthCheck(addr))
		case os.Args[1] == "verify" && len(os.Args) == 3:
			os.Exit(verify(os.Args[2]))
		case os.Args[1] == "fingerprint" && (len(os.Args) == 3 || len(os.Args) == 4):
			os.Exit(fingerprint(os.Args[2], os.Args[3:]))
		}
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	// A cadeia é carregada (e revalidada) antes de escutar: /health 200 significa cadeia carregada
	path := filepath.Join(env("DATA_DIR", "/data"), "chain.bin")
	chain, err := bizas.OpenChain(path, log)
	if err != nil {
		log.Error("could not open the chain", "path", path, "err", err)
		os.Exit(1)
	}
	log.Info("validator listening", "addr", addr, "chain", path, "blocks", chain.Len())
	if err := http.ListenAndServe(addr, bizas.ValidatorHandler(chain, log)); err != nil {
		log.Error("failed", "err", err)
		os.Exit(1)
	}
}

// load lê e confere a cadeia. Devolve o código de saída: 0 se válida, 1 se não é e 2 se não deu para ler
func load(path string) ([]bizas.Block, int) {
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return nil, 2
	}
	chain, err := bizas.ParseChain(raw)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return nil, 2
	}
	if verr, idx := bizas.VerifyChain(chain); verr != bizas.None {
		fmt.Printf("INVALID: %s at block %d (of %d)\n", verr, idx, len(chain))
		return nil, 1
	}
	return chain, 0
}

func verify(path string) int {
	chain, code := load(path)
	if code != 0 {
		return code
	}
	fmt.Printf("valid: %d blocks\n", len(chain))
	if len(chain) > 0 {
		fp, _ := bizas.Fingerprint(chain, len(chain))
		fmt.Printf("fingerprint: #%d %s\n", len(chain), fp)
	}
	return 0
}

// fingerprint imprime "#N <hex>" para comparar com a impressão digital que outra pessoa vê na página. Só para cadeia
// válida: a impressão digital de uma cadeia inválida não prova nada
func fingerprint(path string, args []string) int {
	chain, code := load(path)
	if code != 0 {
		return code
	}
	height := len(chain)
	if len(args) == 1 {
		h, err := strconv.Atoi(args[0])
		if err != nil {
			fmt.Fprintln(os.Stderr, "error: height must be a number:", args[0])
			return 2
		}
		height = h
	}
	fp, err := bizas.Fingerprint(chain, height)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 2
	}
	fmt.Printf("#%d %s\n", height, fp)
	return 0
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
