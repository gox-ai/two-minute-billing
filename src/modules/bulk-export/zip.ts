/**
 * The export's files: each CSV is stored as raw deflate in parts, with its CRC-32 and sizes
 * known when it is written, so the zip is assembled on download by writing headers around
 * the stored bytes: nothing is compressed twice and nothing is held whole in memory.
 *
 * A file's deflate stream is a run of independent segments, each one page of CSV compressed
 * and ended with a sync flush (no final bit), then one empty final block. Concatenated
 * segments are one valid stream because no segment refers back into another.
 */
import { crc32, deflateRawSync, constants } from "node:zlib";

/** Stored part size. */
export const PART_BYTES = 8 * 1024 * 1024;
/** No zip64: a file or the archive past this fails the export with a reason. */
export const ZIP_LIMIT = 0xffff_fffe;

export interface StoredFile {
  name: string;
  crc: number;
  size: number;
  compressed: number;
}

/** Collects one file's CSV pages into compressed parts. */
export class FileWriter {
  crc = 0;
  size = 0;
  compressed = 0;
  parts = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly flushPart: (seq: number, data: Buffer) => Promise<void>) {}

  async write(text: string): Promise<void> {
    if (!text) return;
    const raw = Buffer.from(text, "utf8");
    this.crc = crc32(raw, this.crc);
    this.size += raw.length;
    if (this.size > ZIP_LIMIT) throw new ExportTooLargeError();
    await this.push(deflateRawSync(raw, { level: 6, finishFlush: constants.Z_SYNC_FLUSH }));
  }

  async end(): Promise<void> {
    await this.push(deflateRawSync(Buffer.alloc(0)));
    if (this.pendingBytes) await this.emit();
  }

  private async push(seg: Buffer) {
    this.pending.push(seg);
    this.pendingBytes += seg.length;
    this.compressed += seg.length;
    if (this.pendingBytes >= PART_BYTES) await this.emit();
  }

  private async emit() {
    const data = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    await this.flushPart(this.parts++, data);
  }
}

export class ExportTooLargeError extends Error {
  constructor() {
    super("The export is larger than 4 GB. Select fewer records or a shorter date range.");
  }
}

/** A small file compressed whole (the README). */
export function storeWhole(text: string): { crc: number; size: number; data: Buffer } {
  const raw = Buffer.from(text, "utf8");
  return { crc: crc32(raw), size: raw.length, data: deflateRawSync(raw) };
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const UTF8_NAMES = 0x0800;

export function localHeader(f: StoredFile, at: Date): Buffer {
  const name = Buffer.from(f.name, "utf8");
  const { time, date } = dosTime(at);
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(UTF8_NAMES, 6);
  b.writeUInt16LE(8, 8);
  b.writeUInt16LE(time, 10);
  b.writeUInt16LE(date, 12);
  b.writeUInt32LE(f.crc >>> 0, 14);
  b.writeUInt32LE(f.compressed, 18);
  b.writeUInt32LE(f.size, 22);
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(0, 28);
  return Buffer.concat([b, name]);
}

/** The central directory and its end record, for files written at the given offsets. */
export function centralDirectory(
  files: Array<StoredFile & { offset: number }>,
  at: Date,
  start: number,
): Buffer {
  const { time, date } = dosTime(at);
  const entries = files.map((f) => {
    const name = Buffer.from(f.name, "utf8");
    const b = Buffer.alloc(46);
    b.writeUInt32LE(0x02014b50, 0);
    b.writeUInt16LE(20, 4);
    b.writeUInt16LE(20, 6);
    b.writeUInt16LE(UTF8_NAMES, 8);
    b.writeUInt16LE(8, 10);
    b.writeUInt16LE(time, 12);
    b.writeUInt16LE(date, 14);
    b.writeUInt32LE(f.crc >>> 0, 16);
    b.writeUInt32LE(f.compressed, 20);
    b.writeUInt32LE(f.size, 24);
    b.writeUInt16LE(name.length, 28);
    b.writeUInt32LE(f.offset, 42);
    return Buffer.concat([b, name]);
  });
  const dir = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(start, 16);
  return Buffer.concat([dir, end]);
}
