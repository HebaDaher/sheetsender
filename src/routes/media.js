// Images and videos attached to campaigns.
import { owned } from './util.js';

const LIMITS = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024 }; // WhatsApp Cloud API limits

export function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', kind: 'image' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', kind: 'image' };
  if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    return brand.startsWith('3g') ? { mime: 'video/3gpp', kind: 'video' } : { mime: 'video/mp4', kind: 'video' };
  }
  return null;
}

export function checkMedia(file) {
  const t = sniff(file.data);
  if (!t) throw new Error(`"${file.filename}" is not a JPG/PNG image or an MP4 video.`);
  if (file.data.length > LIMITS[t.kind]) throw new Error(`"${file.filename}" is too large. Images can be up to 5 MB and videos up to 16 MB.`);
  return { ...t, data: file.data, filename: file.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'file' };
}

export default function register(r) {
  r.get('/media/:id', async (ctx) => {
    const m = await owned('media', ctx.params.id, ctx.user);
    ctx.res.writeHead(200, { 'Content-Type': m.mime, 'Content-Length': m.data.length, 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline' });
    ctx.res.end(m.data);
  });
}
