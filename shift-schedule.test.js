const test = require('node:test');
const assert = require('node:assert/strict');
const calcularHorarioTurno = require('./shift-schedule');

test('mantiene los horarios normales de ocho horas', () => {
  assert.deepEqual(calcularHorarioTurno('07:00', 8), {
    inicio: '07:00',
    fin: '15:00',
    cruzaMedianoche: false
  });
  assert.deepEqual(calcularHorarioTurno('15:00', 8), {
    inicio: '15:00',
    fin: '23:00',
    cruzaMedianoche: false
  });
});

test('calcula turnos de verano de nueve horas incluso al cruzar medianoche', () => {
  assert.deepEqual(calcularHorarioTurno('07:00', 9), {
    inicio: '07:00',
    fin: '16:00',
    cruzaMedianoche: false
  });
  assert.deepEqual(calcularHorarioTurno('15:00', 9), {
    inicio: '15:00',
    fin: '00:00',
    cruzaMedianoche: true
  });
  assert.deepEqual(calcularHorarioTurno('23:00', 9), {
    inicio: '23:00',
    fin: '08:00',
    cruzaMedianoche: true
  });
});

test('rechaza duraciones que no cubren la jornada continua de tres turnos', () => {
  assert.throws(() => calcularHorarioTurno('07:00', 7), RangeError);
  assert.throws(() => calcularHorarioTurno('07:00', 13), RangeError);
});
