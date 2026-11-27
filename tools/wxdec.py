"""Decrypt a V1MMWX-encrypted wxapkg (PC/Mac WeChat cache) and unpack it."""
import sys, hashlib, subprocess, struct, os
src, appid, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
d = open(src, 'rb').read()
assert d[:6] == b'V1MMWX'
key = hashlib.pbkdf2_hmac('sha1', appid.encode(), b'saltiest', 1000, 32)
iv = b'the iv: 16 bytes'
head = subprocess.run(['openssl', 'enc', '-d', '-aes-256-cbc', '-nopad', '-K', key.hex(), '-iv', iv.hex()],
                      input=d[6:1024 + 6], capture_output=True, check=True).stdout
xk = ord(appid[-2]) if len(appid) >= 2 else 0x66
tail = bytes(b ^ xk for b in d[1024 + 6:])
plain = head[:1023] + tail
assert plain[0] == 0xBE and plain[13] == 0xED, plain[:16].hex()
_, _, idx_len, data_len = struct.unpack('>BIII', plain[:13])
n = struct.unpack('>I', plain[14:18])[0]
o = 18
os.makedirs(outdir, exist_ok=True)
for _ in range(n):
    ln = struct.unpack('>I', plain[o:o + 4])[0]; o += 4
    name = plain[o:o + ln].decode(); o += ln
    off, size = struct.unpack('>II', plain[o:o + 8]); o += 8
    p = os.path.normpath(os.path.join(outdir, name.lstrip('/')))
    assert p.startswith(os.path.abspath(outdir))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'wb').write(plain[off:off + size])
    print(size, name)
