function elegirAleatorio(elementos) {
  return elementos[Math.floor(Math.random() * elementos.length)];
}

function barajar(elementos) {
  const resultado = [...elementos];
  for (let indice = resultado.length - 1; indice > 0; indice--) {
    const aleatorio = Math.floor(Math.random() * (indice + 1));
    [resultado[indice], resultado[aleatorio]] = [resultado[aleatorio], resultado[indice]];
  }
  return resultado;
}

function sumarDiasISO(fecha, cantidad) {
  if (!fecha) return null;
  const dia = new Date(`${fecha}T00:00:00.000Z`);
  dia.setUTCDate(dia.getUTCDate() + cantidad);
  return dia.toISOString().slice(0, 10);
}

function crearEstadisticasHistoricas(empleados, historial, semanaInicio) {
  const fechaAnterior = sumarDiasISO(semanaInicio, -1);
  const sabadoAnterior = sumarDiasISO(semanaInicio, -2);
  const domingoAnterior = sumarDiasISO(semanaInicio, -1);
  const estadisticas = new Map(empleados.map(empleado => [empleado.id, {
    noches: 0,
    turnosFinSemana: 0,
    trabajoFinSemanaAnterior: false,
    nocheDiaAnterior: false,
    nochesSemana: 0,
    turnosFinSemanaSemana: 0
  }]));

  historial.forEach(asignacion => {
    const datos = estadisticas.get(Number(asignacion.id_atendedor));
    if (!datos || asignacion.turno === 'libre') return;
    if (asignacion.turno === 'noche') datos.noches++;
    const dia = new Date(`${asignacion.fecha}T00:00:00.000Z`).getUTCDay();
    if (dia === 0 || dia === 6) datos.turnosFinSemana++;
    if (asignacion.fecha === fechaAnterior) {
      datos.nocheDiaAnterior = asignacion.turno === 'noche';
    }
    if ((asignacion.fecha === sabadoAnterior || asignacion.fecha === domingoAnterior) &&
        (dia === 0 || dia === 6)) {
      datos.trabajoFinSemanaAnterior = true;
    }
  });
  return estadisticas;
}

function hayNocheAnterior(empleado, dia, historial, horarios) {
  return dia > 0
    ? horarios.get(empleado.id)[dia - 1] === 'noche'
    : historial.get(empleado.id).nocheDiaAnterior;
}

function compararPuntajes(izquierda, derecha) {
  for (let indice = 0; indice < izquierda.length; indice++) {
    if (izquierda[indice] !== derecha[indice]) return izquierda[indice] - derecha[indice];
  }
  return 0;
}

function elegirMenorPuntaje(elementos, obtenerPuntaje) {
  let mejores = [];
  let mejorPuntaje;
  elementos.forEach(elemento => {
    const puntaje = obtenerPuntaje(elemento);
    const comparacion = mejorPuntaje ? compararPuntajes(puntaje, mejorPuntaje) : -1;
    if (comparacion < 0) {
      mejorPuntaje = puntaje;
      mejores = [elemento];
    } else if (comparacion === 0) {
      mejores.push(elemento);
    }
  });
  return elegirAleatorio(mejores);
}

function elegirPorRotacion(candidatos, turno, dia, frecuencias, historial, horarios) {
  return elegirMenorPuntaje(candidatos, empleado =>
    puntajeEmpleado(empleado, turno, dia, frecuencias, historial, horarios)
  );
}

function puntajeEmpleado(empleado, turno, dia, frecuencias, historial, horarios) {
  const datos = historial.get(empleado.id);
  const esNoche = turno === 'noche';
  const esFinSemana = dia >= 5;
  const nocheAnterior = hayNocheAnterior(empleado, dia, historial, horarios);
  return [
    !esNoche && nocheAnterior ? -1 : 0,
    esNoche && nocheAnterior ? 1 : 0,
    esNoche ? datos.noches + datos.nochesSemana : 0,
    esNoche ? 0 : -(datos.noches + datos.nochesSemana),
    esFinSemana && datos.trabajoFinSemanaAnterior ? 1 : 0,
    esFinSemana ? datos.turnosFinSemana + datos.turnosFinSemanaSemana : 0,
    frecuencias.get(empleado.id)[turno]
  ];
}

function elegirTurnoPorRotacion(empleado, turnos, dia, frecuencias, historial, horarios) {
  return elegirMenorPuntaje(turnos, turno => {
    const datos = historial.get(empleado.id);
    const esNoche = turno.valor === 'noche';
    const esFinSemana = dia >= 5;
    const nocheAnterior = hayNocheAnterior(empleado, dia, historial, horarios);
    return [
      !esNoche && nocheAnterior ? -1 : 0,
      esNoche && nocheAnterior ? 1 : 0,
      esNoche ? datos.noches + datos.nochesSemana : 0,
      esNoche ? 0 : -(datos.noches + datos.nochesSemana),
      esFinSemana && datos.trabajoFinSemanaAnterior ? 1 : 0,
      esFinSemana ? datos.turnosFinSemana + datos.turnosFinSemanaSemana : 0,
      frecuencias.get(empleado.id)[turno.valor]
    ];
  });
}

function registrarTurnoGenerado(empleado, turno, dia, frecuencias, historial) {
  frecuencias.get(empleado.id)[turno]++;
  const datos = historial.get(empleado.id);
  if (turno === 'noche') datos.nochesSemana++;
  if (dia >= 5) datos.turnosFinSemanaSemana++;
}

function generarTurnosEquitativos(empleados, minimos, opciones = {}) {
  const turnos = [
    { clave: 'manana', valor: 'mañana', minimo: minimos.manana },
    { clave: 'tarde', valor: 'tarde', minimo: minimos.tarde },
    { clave: 'noche', valor: 'noche', minimo: minimos.noche }
  ];
  if (turnos.some(turno => !Number.isInteger(turno.minimo) || turno.minimo < 1 || turno.minimo > 500)) {
    throw new RangeError('Los mínimos por turno deben ser enteros entre 1 y 500.');
  }

  const elegibles = empleados.filter(empleado =>
    Number(empleado.activo) === 1 && !empleado.licencia
  );
  const historial = crearEstadisticasHistoricas(
    elegibles,
    Array.isArray(opciones.historial) ? opciones.historial : [],
    opciones.semanaInicio || null
  );
  const horarios = new Map(elegibles.map(empleado => [empleado.id, Array(7).fill(null)]));
  const frecuencias = new Map(elegibles.map(empleado => [
    empleado.id,
    Object.fromEntries(turnos.map(turno => [turno.valor, 0]))
  ]));
  const descansosPorDia = Array(7).fill(0);

  for (const empleado of barajar(elegibles)) {
    let mejorPuntaje = Infinity;
    let paresMejores = [];
    for (let primerDia = 0; primerDia < 7; primerDia++) {
      for (let segundoDia = primerDia + 1; segundoDia < 7; segundoDia++) {
        const puntaje =
          (descansosPorDia[primerDia] + 1) ** 2 +
          (descansosPorDia[segundoDia] + 1) ** 2;
        if (puntaje < mejorPuntaje) {
          mejorPuntaje = puntaje;
          paresMejores = [[primerDia, segundoDia]];
        } else if (puntaje === mejorPuntaje) {
          paresMejores.push([primerDia, segundoDia]);
        }
      }
    }

    const [primerDescanso, segundoDescanso] = elegirAleatorio(paresMejores);
    horarios.get(empleado.id)[primerDescanso] = 'libre';
    horarios.get(empleado.id)[segundoDescanso] = 'libre';
    descansosPorDia[primerDescanso]++;
    descansosPorDia[segundoDescanso]++;
  }

  for (let dia = 0; dia < 7; dia++) {
    const disponibles = elegibles.filter(empleado => horarios.get(empleado.id)[dia] === null);
    const minimoDiario = turnos.reduce((total, turno) => total + turno.minimo, 0);
    const ordenTurnos = disponibles.length >= minimoDiario
      ? turnos
      : turnos.map((_, indice) => turnos[(indice + dia) % turnos.length]);

    for (const turno of ordenTurnos) {
      for (let cantidad = 0; cantidad < turno.minimo; cantidad++) {
        const candidatos = elegibles.filter(empleado => {
          const semana = horarios.get(empleado.id);
          if (semana[dia] !== null) return false;
          if (turno.valor === 'mañana' && hayNocheAnterior(empleado, dia, historial, horarios)) return false;
          return true;
        });
        if (candidatos.length === 0) break;

        const empleado = elegirPorRotacion(candidatos, turno.valor, dia, frecuencias, historial, horarios);
        horarios.get(empleado.id)[dia] = turno.valor;
        registrarTurnoGenerado(empleado, turno.valor, dia, frecuencias, historial);
      }
    }
  }

  for (let dia = 0; dia < 7; dia++) {
    const cantidadPorTurno = Object.fromEntries(turnos.map(turno => [turno.valor, 0]));
    for (const empleado of elegibles) {
      const turno = horarios.get(empleado.id)[dia];
      if (turno && turno !== 'libre') cantidadPorTurno[turno]++;
    }

    for (const empleado of barajar(elegibles)) {
      const semana = horarios.get(empleado.id);
      if (semana[dia] !== null) continue;

      const permitidos = turnos.filter(turno => {
        if (turno.valor === 'mañana' &&
            ((dia > 0 && semana[dia - 1] === 'noche') ||
             (dia === 0 && historial.get(empleado.id).nocheDiaAnterior))) return false;
        if (turno.valor === 'noche' && hayNocheAnterior(empleado, dia, historial, horarios)) return false;
        if (turno.valor === 'noche' && dia < 6 && semana[dia + 1] === 'mañana') return false;
        return true;
      });
      if (permitidos.length === 0) continue;
      const menorExceso = Math.min(...permitidos.map(turno =>
        cantidadPorTurno[turno.valor] - turno.minimo
      ));
      const turnosEquilibrados = permitidos.filter(turno =>
        cantidadPorTurno[turno.valor] - turno.minimo === menorExceso
      );
      const turnoElegido = elegirTurnoPorRotacion(
        empleado,
        turnosEquilibrados,
        dia,
        frecuencias,
        historial,
        horarios
      );
      semana[dia] = turnoElegido.valor;
      registrarTurnoGenerado(empleado, turnoElegido.valor, dia, frecuencias, historial);
      cantidadPorTurno[turnoElegido.valor]++;
    }
  }

  return Object.fromEntries(horarios);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = generarTurnosEquitativos;
}
