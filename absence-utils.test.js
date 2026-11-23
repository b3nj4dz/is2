const test = require('node:test');
const assert = require('node:assert/strict');
const { obtenerSemanaISO, buscarAusenciaEnFecha } = require('./absence-utils');

test('obtiene la semana de lunes a domingo para cualquier día de referencia', () => {
  assert.deepEqual(obtenerSemanaISO('2026-11-23'), [
    '2026-11-23',
    '2026-11-24',
    '2026-11-25',
    '2026-11-26',
    '2026-11-27',
    '2026-11-28',
    '2026-11-29'
  ]);
  assert.deepEqual(obtenerSemanaISO('2026-11-29')[0], '2026-11-23');
});

test('busca ausencias por atendedor y aplica los límites de fechas inclusivamente', () => {
  const ausencias = [{
    id_atendedor: 4,
    tipo: 'vacaciones',
    fecha_inicio: '2026-11-25',
    fecha_termino: '2026-11-27'
  }];
  assert.equal(buscarAusenciaEnFecha(ausencias, 4, '2026-11-25').tipo, 'vacaciones');
  assert.equal(buscarAusenciaEnFecha(ausencias, 4, '2026-11-27').tipo, 'vacaciones');
  assert.equal(buscarAusenciaEnFecha(ausencias, 4, '2026-11-28'), null);
  assert.equal(buscarAusenciaEnFecha(ausencias, 5, '2026-11-26'), null);
});

test('rechaza fechas inexistentes al calcular la semana', () => {
  assert.throws(() => obtenerSemanaISO('2026-02-30'), RangeError);
});
