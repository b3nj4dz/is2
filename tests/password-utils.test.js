const test = require('node:test');
const assert = require('node:assert/strict');
const {
  esContrasenaSegura,
  esHashContrasena,
  hashContrasena,
  verificarContrasena
} = require('../src/password-utils');

test('exige largo y variedad de caracteres', () => {
  assert.equal(esContrasenaSegura('Abcdef1!'), true);
  assert.equal(esContrasenaSegura('Ab1!xyz'), false);
  assert.equal(esContrasenaSegura('abcdefg1!'), false);
  assert.equal(esContrasenaSegura('ABCDEFG1!'), false);
  assert.equal(esContrasenaSegura('Abcdefgh!'), false);
  assert.equal(esContrasenaSegura('Abcdefg1'), false);
});

test('crea hashes con sal y verifica solo la contraseña correcta', async () => {
  const password = 'Segura123!';
  const hash = await hashContrasena(password);

  assert.equal(esHashContrasena(hash), true);
  assert.notEqual(hash, password);
  assert.equal(await verificarContrasena(password, hash), true);
  assert.equal(await verificarContrasena('Incorrecta123!', hash), false);
});

test('permite verificar temporalmente contraseñas legadas para migrarlas', async () => {
  assert.equal(await verificarContrasena('ClaveAntigua1!', 'ClaveAntigua1!'), true);
  assert.equal(await verificarContrasena('OtraClave1!', 'ClaveAntigua1!'), false);
});
