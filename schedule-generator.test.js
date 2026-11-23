const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const generarTurnosEquitativos = require('./schedule-generator');

const MINIMOS = { manana: 2, tarde: 1, noche: 2 };
const TURNOS = [
  ['manana', 'mañana'],
  ['tarde', 'tarde'],
  ['noche', 'noche']
];

function crearEmpleados(cantidad) {
  return Array.from({ length: cantidad }, (_, indice) => ({
    id: indice + 1,
    activo: 1,
    licencia: false
  }));
}

function verificarReglas(horarios, empleados, coberturaCompleta, minimos = MINIMOS) {
  const descansos = Array(7).fill(0);
  for (const empleado of empleados) {
    const semana = horarios[empleado.id];
    assert.equal(semana.length, 7);
    assert.equal(semana.filter(turno => turno === 'libre').length, 2);

    for (let dia = 0; dia < 7; dia++) {
      if (semana[dia] === 'libre') descansos[dia]++;
      if (dia > 0) {
        assert.notDeepEqual([semana[dia - 1], semana[dia]], ['noche', 'mañana']);
      }
    }
  }

  if (coberturaCompleta) {
    for (let dia = 0; dia < 7; dia++) {
      for (const [clave, turno] of TURNOS) {
        const asignados = empleados.filter(empleado => horarios[empleado.id][dia] === turno).length;
        assert.ok(asignados >= minimos[clave], `${turno} insuficiente el día ${dia}`);
      }
    }
  }
  return descansos;
}

test('genera cobertura completa con siete atendedores y mínimos 2/1/2', () => {
  const empleados = crearEmpleados(7);
  for (let intento = 0; intento < 100; intento++) {
    const horarios = generarTurnosEquitativos(empleados, MINIMOS);
    const descansos = verificarReglas(horarios, empleados, true);
    assert.deepEqual(descansos, Array(7).fill(2));
  }
});

test('respeta cobertura y descansos cuando hay personal adicional y licencias', () => {
  const empleados = crearEmpleados(9);
  empleados[0].licencia = true;
  empleados[1].activo = 0;
  const elegibles = empleados.slice(2);

  for (let intento = 0; intento < 30; intento++) {
    const horarios = generarTurnosEquitativos(empleados, MINIMOS);
    assert.equal(Object.keys(horarios).length, elegibles.length);
    verificarReglas(horarios, elegibles, true);
  }
});

test('evita noches consecutivas cuando hay suficiente personal', () => {
  const empleados = crearEmpleados(9);
  for (let intento = 0; intento < 100; intento++) {
    const horarios = generarTurnosEquitativos(empleados, MINIMOS);
    verificarReglas(horarios, empleados, true);
    empleados.forEach(empleado => {
      const semana = horarios[empleado.id];
      for (let dia = 1; dia < semana.length; dia++) {
        assert.notDeepEqual([semana[dia - 1], semana[dia]], ['noche', 'noche']);
      }
    });
  }
});

test('aplica correctamente mínimos configurados distintos por turno', () => {
  const empleados = crearEmpleados(10);
  const minimos = { manana: 3, tarde: 2, noche: 2 };
  for (let intento = 0; intento < 30; intento++) {
    const horarios = generarTurnosEquitativos(empleados, minimos);
    verificarReglas(horarios, empleados, true, minimos);
  }
});

test('devuelve una propuesta válida aunque la dotación no alcance los mínimos', () => {
  const empleados = crearEmpleados(6);
  const horarios = generarTurnosEquitativos(empleados, MINIMOS);
  verificarReglas(horarios, empleados, false);

  const hayDeficit = Array.from({ length: 7 }, (_, dia) =>
    TURNOS.some(([clave, turno]) =>
      empleados.filter(empleado => horarios[empleado.id][dia] === turno).length < MINIMOS[clave]
    )
  ).some(Boolean);
  assert.equal(hayDeficit, true);
});

test('prioriza el historial reciente y evita asignar mañana después de una noche', () => {
  const empleados = crearEmpleados(7);
  const historial = Array.from({ length: 15 }, (_, indice) => {
    const fecha = new Date(Date.UTC(2026, 8, 1 + indice));
    while (fecha.getUTCDay() === 0 || fecha.getUTCDay() === 6) {
      fecha.setUTCDate(fecha.getUTCDate() + 1);
    }
    return {
      id_atendedor: 1,
      fecha: fecha.toISOString().slice(0, 10),
      turno: 'noche'
    };
  });
  historial.push({
    id_atendedor: 1,
    fecha: '2026-11-22',
    turno: 'noche'
  });

  const horarios = generarTurnosEquitativos(empleados, MINIMOS, {
    semanaInicio: '2026-11-23',
    historial
  });
  verificarReglas(horarios, empleados, true);
  assert.ok(horarios[1].filter(turno => turno === 'noche').length <= 1);
  assert.notEqual(horarios[1][0], 'mañana');
});

test('genera cinco semanas para 500 atendedores en menos de cinco segundos', () => {
  const empleados = crearEmpleados(500);
  const historial = [];
  const inicio = performance.now();
  for (let semana = 0; semana < 5; semana++) {
    const fechaInicio = new Date(Date.UTC(2026, 0, 5 + semana * 7)).toISOString().slice(0, 10);
    const horarios = generarTurnosEquitativos(empleados, MINIMOS, {
      semanaInicio: fechaInicio,
      historial
    });
    for (const [idAtendedor, turnos] of Object.entries(horarios)) {
      turnos.forEach((turno, dia) => {
        const fecha = new Date(`${fechaInicio}T00:00:00.000Z`);
        fecha.setUTCDate(fecha.getUTCDate() + dia);
        historial.push({
          id_atendedor: Number(idAtendedor),
          fecha: fecha.toISOString().slice(0, 10),
          turno
        });
      });
    }
  }
  assert.ok(performance.now() - inicio < 5000);
});
