// Criptografia do data.json (o repositório é público): AES-256-GCM com chave derivada da senha do painel (PBKDF2-SHA256).
// Formato gravado: { enc: 1, kdf: 'PBKDF2-SHA256', it, salt, iv, ct } — ct = texto cifrado + tag (mesmo formato do WebCrypto do navegador).
// Sem PAINEL_SENHA definida, tudo continua em texto aberto (compatível com o formato antigo).
import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
const SENHA = String(process.env.PAINEL_SENHA || '').trim();
const IT = 200000;
const keys = new Map();
const keyFor = salt => { if (!keys.has(salt)) keys.set(salt, pbkdf2Sync(SENHA, Buffer.from(salt, 'base64'), IT, 32, 'sha256')); return keys.get(salt); };
let ultimoSalt = null;
export function abrirDados(base64Content) {
  const obj = JSON.parse(Buffer.from(base64Content, 'base64').toString('utf8'));
  if (!obj || !obj.enc) return obj;
  if (!SENHA) throw new Error('data.json está criptografado e PAINEL_SENHA não foi definida');
  ultimoSalt = obj.salt;
  const raw = Buffer.from(obj.ct, 'base64'), tag = raw.subarray(raw.length - 16), ct = raw.subarray(0, raw.length - 16);
  const d = createDecipheriv('aes-256-gcm', keyFor(obj.salt), Buffer.from(obj.iv, 'base64')); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}
export function fecharDados(data) {
  const plain = Buffer.from(JSON.stringify(data));
  if (!SENHA) return plain.toString('base64');
  const salt = ultimoSalt || randomBytes(16).toString('base64'); ultimoSalt = salt;
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyFor(salt), iv);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return Buffer.from(JSON.stringify({ enc: 1, kdf: 'PBKDF2-SHA256', it: IT, salt, iv: iv.toString('base64'), ct: ct.toString('base64') })).toString('base64');
}
