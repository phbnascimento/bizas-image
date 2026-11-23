package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"image/png"
	"io/fs"
	"os"
	"strings"
	"testing"
)

// As bibliotecas embutidas têm de ser as conferidas por scripts/fetch-tweetnacl.sh e scripts/fetch-qrcode.sh
func TestVendoredHashes(t *testing.T) {
	for _, c := range []struct{ sumFile, name string }{
		{"tweetnacl.sha256", "nacl-fast.min.js"},
		{"qrcode.sha256", "qrcode.js"},
	} {
		line, err := os.ReadFile(c.sumFile)
		if err != nil {
			t.Fatal(err)
		}
		want, name, ok := strings.Cut(strings.TrimSpace(string(line)), "  ")
		if !ok || name != c.name || len(want) != 64 {
			t.Fatalf("malformed %s: %q", c.sumFile, line)
		}
		data, err := fs.ReadFile(Static(), name)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		if got := hex.EncodeToString(sum[:]); got != want {
			t.Fatalf("embedded %s: %s, want %s", name, got, want)
		}
	}
}

// A logo da página é a mesma de assets/bizas.png (o go:embed não alcança fora do pacote, então há uma cópia)
func TestLogoIsTheAsset(t *testing.T) {
	want, err := os.ReadFile("../../assets/bizas.png")
	if err != nil {
		t.Fatal(err)
	}
	got, err := fs.ReadFile(Static(), "bizas.png")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("static/bizas.png differs from assets/bizas.png; copy it again")
	}
}

func near(got uint32, want, tol int) bool {
	d := int(got) - want
	return d >= -tol && d <= tol
}

// A logo usa só o magenta do Everblush (#c47fd5); a transparência vem do canal alfa
func TestLogoColor(t *testing.T) {
	data, err := fs.ReadFile(Static(), "bizas.png")
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	b := img.Bounds()
	opaque := 0
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, a := img.At(x, y).RGBA()
			if a == 0 {
				continue
			}
			opaque++
			// RGBA() devolve valores pré-multiplicados de 16 bits; desfaz a multiplicação para comparar a cor
			tol := 1 // bordas com alfa parcial perdem um tom no arredondamento
			if a == 0xffff {
				tol = 0
			}
			if !near(r*0xff/a, 0xc4, tol) || !near(g*0xff/a, 0x7f, tol) || !near(bl*0xff/a, 0xd5, tol) {
				t.Fatalf("pixel (%d,%d) is not #c47fd5", x, y)
			}
		}
	}
	if opaque == 0 {
		t.Fatal("the logo has no visible pixels")
	}
}

func TestPageFiles(t *testing.T) {
	for _, name := range []string{"index.html", "style.css", "app.js", "bizas.js", "when.js", "i18n.js", "qrcode.js", "bizas.png", "nacl-fast.min.js"} {
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
