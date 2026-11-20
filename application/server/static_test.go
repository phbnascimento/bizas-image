package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"strings"
	"testing"
)

// O tweetnacl embutido tem de ser o conferido por scripts/fetch-tweetnacl.sh
func TestTweetnaclHash(t *testing.T) {
	line, err := os.ReadFile("tweetnacl.sha256")
	if err != nil {
		t.Fatal(err)
	}
	want, name, ok := strings.Cut(strings.TrimSpace(string(line)), "  ")
	if !ok || name != "nacl-fast.min.js" || len(want) != 64 {
		t.Fatalf("malformed tweetnacl.sha256: %q", line)
	}
	data, err := fs.ReadFile(Static(), name)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if got := hex.EncodeToString(sum[:]); got != want {
		t.Fatalf("embedded nacl-fast.min.js: %s, want %s", got, want)
	}
}

func TestPageFiles(t *testing.T) {
	for _, name := range []string{"index.html", "style.css", "app.js", "bizas.js", "when.js", "nacl-fast.min.js"} {
		if _, err := fs.Stat(Static(), name); err != nil {
			t.Errorf("%s not embedded: %v", name, err)
		}
	}
	page, err := fs.ReadFile(Static(), "index.html")
	if err != nil {
		t.Fatal(err)
	}
	// Nenhuma referência externa: a página tem de funcionar sem internet
	for _, bad := range []string{"http://", "https://", "//cdn"} {
		if strings.Contains(string(page), bad) {
			t.Errorf("index.html references %q", bad)
		}
	}
}
