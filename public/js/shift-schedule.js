function calcularHorarioTurno(horaInicio, duracionHoras) {
  if (typeof horaInicio !== 'string' || !/^\d{2}:\d{2}$/.test(horaInicio)) {
    throw new TypeError('La hora de inicio debe tener formato HH:MM.');
  }
  if (!Number.isInteger(duracionHoras) || duracionHoras < 8 || duracionHoras > 12) {
    throw new RangeError('La duración del turno debe ser un entero entre 8 y 12 horas.');
  }

  const [horas, minutos] = horaInicio.split(':').map(Number);
  if (horas > 23 || minutos > 59) throw new RangeError('La hora de inicio no es válida.');

  const minutosInicio = horas * 60 + minutos;
  const minutosSinAjustar = minutosInicio + duracionHoras * 60;
  const minutosFinales = minutosSinAjustar % (24 * 60);
  const horaFin = `${String(Math.floor(minutosFinales / 60)).padStart(2, '0')}:${String(minutosFinales % 60).padStart(2, '0')}`;
  return { inicio: horaInicio, fin: horaFin, cruzaMedianoche: minutosSinAjustar >= 24 * 60 };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = calcularHorarioTurno;
}
