// A página servida aos dispositivos. Nada é buscado em CDN: o tweetnacl vem copiado em static/
// (scripts/fetch-tweetnacl.sh)

package main

import (
	"embed"
	"io/fs"
)

//go:embed static
var embedded embed.FS

// Static devolve os arquivos da página, com index.html na raiz
func Static() fs.FS {
	sub, err := fs.Sub(embedded, "static")
	if err != nil {
		panic(err) // só falha se o diretório embutido não existir
	}
	return sub
}
