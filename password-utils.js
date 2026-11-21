const crypto = require('crypto');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;

function esContrasenaSegura(password) {
  return typeof password === 'string' &&
    password.length >= 8 &&
    password.length <= 128 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9\s]/.test(password);
}

function derivarContrasena(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (err, derivedKey) => {
        if (err) return reject(err);
        resolve(derivedKey);
      }
    );
  });
}

async function hashContrasena(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await derivarContrasena(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

async function verificarContrasena(password, almacenada) {
  if (typeof password !== 'string' || typeof almacenada !== 'string') return false;
  if (!almacenada.startsWith('scrypt$')) {
    const entrada = Buffer.from(password);
    const anterior = Buffer.from(almacenada);
    return entrada.length === anterior.length && crypto.timingSafeEqual(entrada, anterior);
  }

  const [algoritmo, n, r, p, saltHex, hashHex] = almacenada.split('$');
  if (algoritmo !== 'scrypt' || Number(n) !== SCRYPT_N ||
      Number(r) !== SCRYPT_R || Number(p) !== SCRYPT_P ||
      !/^[0-9a-f]{32}$/i.test(saltHex || '') ||
      !/^[0-9a-f]{128}$/i.test(hashHex || '')) {
    return false;
  }

  const expected = Buffer.from(hashHex, 'hex');
  const actual = await derivarContrasena(password, Buffer.from(saltHex, 'hex'));
  return crypto.timingSafeEqual(actual, expected);
}

function esHashContrasena(almacenada) {
  return typeof almacenada === 'string' && almacenada.startsWith('scrypt$');
}

module.exports = { esContrasenaSegura, esHashContrasena, hashContrasena, verificarContrasena };
