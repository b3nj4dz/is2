function obtenerSemanaISO(fechaReferencia) {
  if (typeof fechaReferencia !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fechaReferencia)) {
    throw new TypeError('La fecha debe tener formato AAAA-MM-DD.');
  }

  const fecha = new Date(`${fechaReferencia}T00:00:00.000Z`);
  if (Number.isNaN(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== fechaReferencia) {
    throw new RangeError('La fecha no es válida.');
  }

  const diasDesdeLunes = (fecha.getUTCDay() + 6) % 7;
  fecha.setUTCDate(fecha.getUTCDate() - diasDesdeLunes);
  return Array.from({ length: 7 }, (_, indice) => {
    const dia = new Date(fecha);
    dia.setUTCDate(fecha.getUTCDate() + indice);
    return dia.toISOString().slice(0, 10);
  });
}

function buscarAusenciaEnFecha(ausencias, idAtendedor, fecha) {
  return ausencias.find(ausencia =>
    Number(ausencia.id_atendedor) === Number(idAtendedor) &&
    ausencia.fecha_inicio <= fecha &&
    ausencia.fecha_termino >= fecha
  ) || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { obtenerSemanaISO, buscarAusenciaEnFecha };
}
