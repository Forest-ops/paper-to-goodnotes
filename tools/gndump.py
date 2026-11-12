"""Dump the contents of an unzipped .goodnotes file as readable protobuf trees.

Usage: python gndump.py <file> [--raw]

Goodnotes record files are a sequence of varint-length-prefixed protobuf messages.
Some byte fields contain Apple "bv41" (LZ4) compressed blobs; these are expanded inline.
"""
import struct
import sys


def read_varint(buf, i):
    shift = result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def lz4_block_decompress(src, out_size):
    dst = bytearray()
    i = 0
    while i < len(src):
        token = src[i]
        i += 1
        lit = token >> 4
        if lit == 15:
            while True:
                b = src[i]
                i += 1
                lit += b
                if b != 255:
                    break
        dst += src[i:i + lit]
        i += lit
        if i >= len(src) or len(dst) >= out_size:
            break
        off = src[i] | (src[i + 1] << 8)
        i += 2
        mlen = token & 15
        if mlen == 15:
            while True:
                b = src[i]
                i += 1
                mlen += b
                if b != 255:
                    break
        mlen += 4
        start = len(dst) - off
        for k in range(mlen):
            dst.append(dst[start + k])
    return bytes(dst)


def apple_decompress(buf):
    """Decode Apple compression_stream LZ4 framing: bv41 blocks, bv4- raw blocks, bv4$ end."""
    out = bytearray()
    i = 0
    while i + 4 <= len(buf):
        magic = buf[i:i + 4]
        if magic == b"bv4$":
            return bytes(out)
        if magic == b"bv41":
            dsize, csize = struct.unpack_from("<II", buf, i + 4)
            out += lz4_block_decompress(buf[i + 12:i + 12 + csize], dsize)
            i += 12 + csize
        elif magic == b"bv4-":
            (dsize,) = struct.unpack_from("<I", buf, i + 4)
            out += buf[i + 8:i + 8 + dsize]
            i += 8 + dsize
        else:
            raise ValueError("unknown block %r at %d" % (magic, i))
    raise ValueError("no end marker")


def try_parse(buf):
    """Parse buf as a protobuf message; return list of (field, wiretype, value) or None."""
    fields = []
    i = 0
    try:
        while i < len(buf):
            key, i = read_varint(buf, i)
            fn, wt = key >> 3, key & 7
            if fn == 0:
                return None
            if wt == 0:
                v, i = read_varint(buf, i)
            elif wt == 1:
                v = buf[i:i + 8]
                i += 8
            elif wt == 2:
                ln, i = read_varint(buf, i)
                v = buf[i:i + ln]
                if len(v) != ln:
                    return None
                i += ln
            elif wt == 5:
                v = buf[i:i + 4]
                i += 4
            else:
                return None
            if i > len(buf):
                return None
            fields.append((fn, wt, v))
    except IndexError:
        return None
    return fields


def is_text(b):
    try:
        s = b.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return all(c.isprintable() or c in "\n\t" for c in s)


def dump(fields, indent=0, out=print):
    pad = "  " * indent
    for fn, wt, v in fields:
        if wt == 0:
            out("%s%d: %d" % (pad, fn, v))
        elif wt == 5:
            (f,) = struct.unpack("<f", v)
            (u,) = struct.unpack("<I", v)
            out("%s%d: f32 %g  (0x%08x)" % (pad, fn, f, u))
        elif wt == 1:
            (d,) = struct.unpack("<d", v)
            out("%s%d: f64 %r" % (pad, fn, d))
        else:
            if v[:4] == b"bv41" or v[:4] == b"bv4-":
                raw = apple_decompress(v)
                out("%s%d: <apple-lz4 %d -> %d bytes>" % (pad, fn, len(v), len(raw)))
                dump_blob(raw, indent + 1, out)
                continue
            if len(v) > 0 and is_text(v):
                out("%s%d: %r" % (pad, fn, v.decode()))
                continue
            sub = try_parse(v) if v else []
            if sub is not None and v:
                out("%s%d {" % (pad, fn))
                dump(sub, indent + 1, out)
                out("%s}" % pad)
            else:
                out("%s%d: bytes[%d] %s" % (pad, fn, len(v), v[:64].hex()))


def dump_blob(raw, indent, out):
    pad = "  " * indent
    sub = try_parse(raw)
    if sub is not None:
        dump(sub, indent, out)
    else:
        out("%sraw[%d] %s" % (pad, len(raw), raw[:96].hex()))


def records(buf):
    i = 0
    while i < len(buf):
        ln, i = read_varint(buf, i)
        yield buf[i:i + ln]
        i += ln


def main():
    path = sys.argv[1]
    buf = open(path, "rb").read()
    for n, rec in enumerate(records(buf)):
        print("=== record %d (%d bytes)" % (n, len(rec)))
        fields = try_parse(rec)
        if fields is None:
            print("  <unparseable> " + rec[:64].hex())
        else:
            dump(fields, 1)


if __name__ == "__main__":
    main()
