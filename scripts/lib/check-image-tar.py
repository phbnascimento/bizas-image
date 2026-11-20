"""Confere um tar de `docker save` sem carregá-lo: a arquitetura declarada na config da imagem e a arquitetura real do
binário /app (cabeçalho ELF)

Uso: python3 -I check-image-tar.py <imagem.tar> <arm64|amd64>
Sai com 0 se as duas conferem, 1 se não, 2 se não deu para ler
"""
import io
import json
import sys
import tarfile

ELF_MACHINE = {0xB7: "arm64", 0x3E: "amd64"}


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    path, want = sys.argv[1], sys.argv[2]
    try:
        tf = tarfile.open(path)
    except (OSError, tarfile.TarError) as e:
        print(f"could not read {path}: {e}")
        return 2

    def blob(digest):
        algo, h = digest.split(":", 1)
        return tf.extractfile(f"blobs/{algo}/{h}").read()

    configs, layers = [], []
    names = tf.getnames()
    if "index.json" in names:
        def walk(desc):
            doc = json.loads(blob(desc["digest"]))
            mt = doc.get("mediaType", desc.get("mediaType", ""))
            if "index" in mt or "manifests" in doc:
                for m in doc.get("manifests", []):
                    if m.get("annotations", {}).get("vnd.docker.reference.type") == "attestation-manifest":
                        continue
                    walk(m)
            else:
                configs.append(json.loads(blob(doc["config"]["digest"])))
                layers.extend(l["digest"] for l in doc["layers"])
        for m in json.loads(tf.extractfile("index.json").read())["manifests"]:
            walk(m)
    elif "manifest.json" in names:
        for m in json.loads(tf.extractfile("manifest.json").read()):
            configs.append(json.loads(tf.extractfile(m["Config"]).read()))
            layers.extend(("file", l) for l in m["Layers"])
    else:
        print(f"{path}: neither index.json nor manifest.json")
        return 2

    if not configs:
        print(f"{path}: no image config found")
        return 2
    ok = True
    for c in configs:
        arch, os_ = c.get("architecture"), c.get("os")
        print(f"config: os={os_} architecture={arch}")
        if arch != want or os_ != "linux":
            ok = False

    found = None
    for l in layers:
        data = tf.extractfile(l[1]).read() if isinstance(l, tuple) else blob(l)
        try:
            lt = tarfile.open(fileobj=io.BytesIO(data))
        except tarfile.TarError:
            continue
        for name in ("app", "./app"):
            try:
                member = lt.getmember(name)
            except KeyError:
                continue
            head = lt.extractfile(member).read(20)
            if head[:4] != b"\x7fELF":
                print("/app is not ELF")
                return 1
            machine = int.from_bytes(head[18:20], "little")
            found = ELF_MACHINE.get(machine, hex(machine))
            print(f"/app: ELF {found}, {member.size} bytes")
    if found is None:
        print("/app not found in the layers")
        return 1
    if found != want:
        ok = False
    print("OK" if ok else f"FAILED: want linux/{want}")
    return 0 if ok else 1


sys.exit(main())
