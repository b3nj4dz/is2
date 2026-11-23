// Estilos visuales por tipo de turno
const TURNOS_ESTILOS = {
  mañana: 'bg-amber-100 text-amber-900 border-amber-300 font-bold',
  tarde: 'bg-blue-100 text-blue-900 border-blue-300 font-bold',
  noche: 'bg-purple-100 text-purple-900 border-purple-300 font-bold',
  libre: 'bg-slate-100 text-slate-600 border-slate-300 font-bold'
};

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const TURNOS_INICIO = {
  mañana: '07:00',
  tarde: '15:00',
  noche: '23:00'
};

let empleados = [];
let empleadoEditandoId = null;
let administradores = [];
let administradorEditandoId = null;
let ausencias = [];
let ausenciaEditandoId = null;
let horarios = {};
let asistencias = [];
let solicitudes = [];
let solicitudEditandoId = null;
let usuarioActual = null;
let tokenCambioContrasena = null;
let colaGuardadoHorarios = Promise.resolve();
let parametrosTemporada = {
  modo: 'normal',
  horas_minimas_normal: 8,
  horas_minimas_verano: 9
};
let parametrosCobertura = { manana: 2, tarde: 1, noche: 2 };
let parametrosCoberturaCargados = false;
let errorParametrosCobertura = '';
let horariosListos = false;
let notificaciones = [];
let flujoNotificaciones = null;
let reconexionServidorTimer = null;
let comprobandoReconexionServidor = false;

const API_URL = 'http://localhost:3000/api';

function limpiarSesionLocal() {
  detenerEscuchaNotificaciones();
  if (reconexionServidorTimer) clearInterval(reconexionServidorTimer);
  reconexionServidorTimer = null;
  mostrarEstadoConexion(true);
  localStorage.removeItem('copec_sesion');
  usuarioActual = null;
  document.getElementById('sec-app').classList.add('hidden');
  document.getElementById('sec-login').classList.remove('hidden');
}

async function apiFetch(url, options = {}) {
  const headers = { ...options.headers };
  if (usuarioActual?.token) {
    headers.Authorization = `Bearer ${usuarioActual.token}`;
  }

  const metodo = (options.method || 'GET').toUpperCase();
  const intentos = metodo === 'GET' ? 3 : 1;
  for (let intento = 0; intento < intentos; intento++) {
    try {
      const res = await fetch(url, { ...options, headers });
      if (res.status >= 500) {
        if (metodo === 'GET' && intento < intentos - 1) {
          await new Promise(resolve => setTimeout(resolve, 500 * (intento + 1)));
          continue;
        }
        mostrarEstadoConexion(false);
        iniciarReintentosConexion();
      } else {
        mostrarEstadoConexion(true);
      }
      if (res.status === 401 && usuarioActual?.token) {
        limpiarSesionLocal();
        mostrarToast('La sesión venció. Inicia sesión nuevamente.');
      }
      return res;
    } catch (err) {
      if (metodo !== 'GET' || intento === intentos - 1) {
        mostrarEstadoConexion(false);
        iniciarReintentosConexion();
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, 500 * (intento + 1)));
    }
  }
}

function mostrarEstadoConexion(conectado) {
  const banner = document.getElementById('banner-conexion');
  if (banner) banner.classList.toggle('hidden', conectado);
}

function iniciarReintentosConexion() {
  if (reconexionServidorTimer || !usuarioActual?.token) return;
  reconexionServidorTimer = setInterval(comprobarReconexionServidor, 5000);
}

async function comprobarReconexionServidor() {
  if (comprobandoReconexionServidor || !usuarioActual?.token) return;
  comprobandoReconexionServidor = true;
  try {
    const res = await fetch(`${API_URL}/horarios`, {
      headers: { Authorization: `Bearer ${usuarioActual.token}` },
      cache: 'no-store'
    });
    if (res.status === 401) {
      limpiarSesionLocal();
      mostrarToast('La sesión venció. Inicia sesión nuevamente.');
      return;
    }
    if (!res.ok) return;
    await res.json();
    clearInterval(reconexionServidorTimer);
    reconexionServidorTimer = null;
    mostrarEstadoConexion(true);
    await sincronizarDatosTrasReconexion();
  } catch (err) {
    console.warn('El servidor sigue sin responder; se reintentará:', err);
  } finally {
    comprobandoReconexionServidor = false;
  }
}

async function sincronizarDatosTrasReconexion() {
  const tareas = [
    cargarEmpleadosBD(),
    cargarParametrosTemporada(),
    cargarSolicitudes()
  ];
  if (usuarioActual?.rol === 'atendedor') {
    tareas.push(cargarNotificaciones());
  } else if (usuarioActual?.rol === 'admin') {
    tareas.push(cargarParametrosCobertura(), cargarAsistenciasBD());
  }
  await Promise.all(tareas);
}

window.addEventListener('online', () => {
  if (reconexionServidorTimer) void comprobarReconexionServidor();
});

function detenerEscuchaNotificaciones() {
  if (flujoNotificaciones) flujoNotificaciones.abort();
  flujoNotificaciones = null;
}

function iniciarEscuchaNotificaciones() {
  if (usuarioActual?.rol !== 'atendedor' || !usuarioActual.token) return;
  detenerEscuchaNotificaciones();
  void escucharNotificaciones(usuarioActual.token);
}

async function escucharNotificaciones(token) {
  while (usuarioActual?.token === token) {
    const controlador = new AbortController();
    flujoNotificaciones = controlador;
    let lector;

    try {
      const res = await apiFetch(`${API_URL}/notificaciones/stream`, {
        headers: { Accept: 'text/event-stream' },
        signal: controlador.signal
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'No se pudo conectar al canal de notificaciones.');
      }
      if (!res.body?.getReader) throw new Error('El navegador no admite el canal de notificaciones.');

      await cargarNotificaciones();
      lector = res.body.getReader();
      const decodificador = new TextDecoder();
      let buffer = '';
      while (usuarioActual?.token === token) {
        const { done, value } = await lector.read();
        if (done) break;
        buffer += decodificador.decode(value, { stream: true });
        const eventos = buffer.split(/\r?\n\r?\n/);
        buffer = eventos.pop() || '';
        eventos.forEach(evento => procesarEventoNotificacion(evento, token));
      }
    } catch (err) {
      if (controlador.signal.aborted || usuarioActual?.token !== token) return;
      console.error('Se perdió el canal de notificaciones; se intentará reconectar:', err);
    } finally {
      if (lector) lector.releaseLock();
      if (flujoNotificaciones === controlador) flujoNotificaciones = null;
    }

    if (usuarioActual?.token === token) {
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

function procesarEventoNotificacion(evento, token) {
  const lineas = evento.split(/\r?\n/);
  if (!lineas.includes('event: notificacion') || usuarioActual?.token !== token) return;
  cargarNotificaciones();
  void cargarEmpleadosBD();
  cargarParametrosTemporada();
  mostrarToast('Recibiste una actualización de horario.');
}

async function cargarNotificaciones() {
  if (usuarioActual?.rol !== 'atendedor') return;

  try {
    const res = await apiFetch(`${API_URL}/notificaciones`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron cargar las notificaciones.');
    notificaciones = data.notificaciones;
    renderizarNotificaciones(data.no_leidas);
  } catch (err) {
    console.error('Error al cargar notificaciones:', err);
    const lista = document.getElementById('lista-notificaciones');
    if (lista) lista.textContent = err.message || 'No se pudieron cargar las notificaciones.';
  }
}

function renderizarNotificaciones(noLeidas) {
  const lista = document.getElementById('lista-notificaciones');
  const insignia = document.getElementById('insignia-notificaciones');
  const botonLeidas = document.getElementById('btn-marcar-notificaciones-leidas');
  if (!lista || !insignia) return;

  const pendientes = Number(noLeidas) || 0;
  insignia.textContent = pendientes > 99 ? '99+' : String(pendientes);
  insignia.classList.toggle('hidden', pendientes === 0);
  if (botonLeidas) botonLeidas.classList.toggle('hidden', pendientes === 0);

  lista.textContent = '';
  if (notificaciones.length === 0) {
    lista.textContent = 'No tienes notificaciones.';
    return;
  }

  notificaciones.forEach(notificacion => {
    const item = document.createElement('article');
    item.className = `border-b border-slate-100 p-3 last:border-0 ${notificacion.leida ? 'bg-white' : 'bg-red-50'}`;
    const mensaje = document.createElement('p');
    mensaje.className = 'text-xs text-slate-800';
    mensaje.textContent = notificacion.mensaje;
    const fecha = document.createElement('time');
    fecha.className = 'mt-1 block text-[10px] text-slate-500';
    fecha.textContent = notificacion.fecha_creacion;
    item.append(mensaje, fecha);
    lista.appendChild(item);
  });
}

async function marcarNotificacionesLeidas() {
  if (usuarioActual?.rol !== 'atendedor') return;

  try {
    const res = await apiFetch(`${API_URL}/notificaciones/leidas`, { method: 'PUT' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron marcar como leídas.');
    await cargarNotificaciones();
  } catch (err) {
    console.error('Error al marcar notificaciones como leídas:', err);
    alert(err.message || 'No se pudieron marcar las notificaciones como leídas.');
  }
}

function togglePanelNotificaciones() {
  const panel = document.getElementById('panel-notificaciones');
  const boton = document.getElementById('btn-notificaciones');
  if (!panel || !boton) return;
  const abrir = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !abrir);
  boton.setAttribute('aria-expanded', String(abrir));
}

function esContrasenaSegura(password) {
  return password.length >= 8 &&
    password.length <= 128 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9\s]/.test(password);
}

window.onload = function () {
  lucide.createIcons();

  if (localStorage.getItem('copec_password_policy_version') !== '3') {
    localStorage.removeItem('copec_sesion');
    localStorage.setItem('copec_password_policy_version', '3');
  }

  const sesionGuardada = localStorage.getItem('copec_sesion');
  if (sesionGuardada) {
    usuarioActual = JSON.parse(sesionGuardada);
    mostrarPanelPrincipal();
  }
};

// --- AUTENTICACIÓN Y LOGIN ---

async function iniciarSesion(e) {
  e.preventDefault();
  tokenCambioContrasena = null;
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  document.getElementById('form-cambiar-contrasena').classList.add('hidden');
  document.getElementById('form-login').classList.remove('hidden');
  document.getElementById('btn-solicitar-desbloqueo').classList.add('hidden');

  try {
    const res = await fetch(`${API_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();

    if (data.requiereCambioContrasena) {
      tokenCambioContrasena = data.tokenCambio;
      document.getElementById('form-login').classList.add('hidden');
      document.getElementById('form-cambiar-contrasena').classList.remove('hidden');
      document.getElementById('nueva-contrasena').focus();
      return;
    }

    if (data.success) {
      usuarioActual = data.usuario;
      localStorage.setItem('copec_sesion', JSON.stringify(usuarioActual));
      mostrarToast(`Bienvenido/a ${usuarioActual.nombre}`);
      mostrarPanelPrincipal();
    } else {
      if (data.bloqueado) {
        document.getElementById('btn-solicitar-desbloqueo').classList.remove('hidden');
      }
      alert(data.error || 'Credenciales incorrectas');
    }
  } catch (err) {
    console.error('Error en login:', err);
    alert('Error de conexión con el servidor');
  }
}

async function guardarNuevaContrasena(e) {
  e.preventDefault();
  const password = document.getElementById('nueva-contrasena').value;
  const confirmacion = document.getElementById('confirmar-contrasena').value;

  if (!esContrasenaSegura(password)) {
    return alert('La contraseña debe tener entre 8 y 128 caracteres e incluir mayúscula, minúscula, número y símbolo.');
  }
  if (password !== confirmacion) {
    return alert('Las contraseñas no coinciden.');
  }

  try {
    const res = await fetch(`${API_URL}/cambiar-contrasena`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenCambio: tokenCambioContrasena, password })
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) cancelarCambioContrasena();
      alert(data.error || 'No se pudo actualizar la contraseña.');
      return;
    }

    tokenCambioContrasena = null;
    document.getElementById('form-cambiar-contrasena').reset();
    document.getElementById('form-cambiar-contrasena').classList.add('hidden');
    document.getElementById('form-login').classList.remove('hidden');
    document.getElementById('login-password').value = '';
    alert(data.message);
  } catch (err) {
    console.error('Error al cambiar contraseña:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

function cancelarCambioContrasena() {
  tokenCambioContrasena = null;
  document.getElementById('form-cambiar-contrasena').reset();
  document.getElementById('form-cambiar-contrasena').classList.add('hidden');
  document.getElementById('form-login').classList.remove('hidden');
}

async function solicitarDesbloqueo() {
  const email = document.getElementById('login-email').value.trim();
  if (!email) {
    alert('Ingresa el correo de la cuenta bloqueada.');
    return;
  }

  try {
    const res = await fetch(`${API_URL}/solicitudes-desbloqueo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'No se pudo enviar la solicitud.');
      return;
    }
    mostrarToast(data.message);
  } catch (err) {
    console.error('Error al solicitar desbloqueo:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

function mostrarPanelPrincipal() {
  document.getElementById('sec-login').classList.add('hidden');
  document.getElementById('sec-app').classList.remove('hidden');
  
  const txtUser = document.getElementById('usuario-sesion-txt');
  if (txtUser && usuarioActual) {
    const esAdmin = usuarioActual.rol === 'admin';
    const etiquetaRol = esAdmin ? '[ADMINISTRADOR]' : '[ATENDEDOR]';
    txtUser.textContent = `${etiquetaRol} ${usuarioActual.nombre} (${usuarioActual.email})`;
  }

  aplicarPermisosPorRol();

  const inputFecha = document.getElementById('asist-fecha');
  if (inputFecha) inputFecha.valueAsDate = new Date();

  cargarEmpleadosBD();
  cargarParametrosTemporada();
  if (usuarioActual && usuarioActual.rol === 'admin') {
    detenerEscuchaNotificaciones();
    cargarAdministradoresBD();
    cargarSolicitudesDesbloqueo();
    cargarAsistenciasBD();
    cargarParametrosCobertura();
  } else if (usuarioActual?.rol === 'atendedor') {
    cargarNotificaciones();
    iniciarEscuchaNotificaciones();
  }
  cargarSolicitudes();
}

function aplicarPermisosPorRol() {
  const esAdmin = usuarioActual && usuarioActual.rol === 'admin';
  actualizarControlesTemporada();

  const tabEmpleados = document.getElementById('tab-empleados');
  const tabAdministracion = document.getElementById('tab-administracion');
  const tabAsistencia = document.getElementById('tab-asistencia');
  const secAdministracion = document.getElementById('sec-administracion');
  const btnAuto = document.getElementById('cnt-btn-auto');
  const panelCobertura = document.getElementById('panel-cobertura');
  const btnNotificaciones = document.getElementById('btn-notificaciones');
  const panelNotificaciones = document.getElementById('panel-notificaciones');
  const cuadranteSubtitulo = document.getElementById('cuadrante-subtitulo');
  const panelGestionAusencias = document.getElementById('panel-gestion-ausencias');

  if (panelCobertura) panelCobertura.classList.toggle('hidden', !esAdmin);
  if (panelGestionAusencias) panelGestionAusencias.classList.toggle('hidden', !esAdmin);
  if (btnNotificaciones) btnNotificaciones.classList.toggle('hidden', esAdmin);
  if (esAdmin && panelNotificaciones) panelNotificaciones.classList.add('hidden');
  if (!esAdmin) {
    if (tabEmpleados) tabEmpleados.classList.add('hidden');
    if (tabAdministracion) tabAdministracion.classList.add('hidden');
    if (tabAsistencia) tabAsistencia.classList.add('hidden');
    if (secAdministracion) secAdministracion.classList.add('hidden');
    if (btnAuto) btnAuto.classList.add('hidden');
    if (cuadranteSubtitulo) cuadranteSubtitulo.textContent = 'Consulta la programación y turnos de la semana.';
    cambiarTab('turnos');
  } else {
    if (tabEmpleados) tabEmpleados.classList.remove('hidden');
    if (tabAdministracion) tabAdministracion.classList.remove('hidden');
    if (tabAsistencia) tabAsistencia.classList.remove('hidden');
    if (btnAuto) btnAuto.classList.remove('hidden');
    if (cuadranteSubtitulo) cuadranteSubtitulo.textContent = 'Selecciona el turno directamente en cada casilla para ajustar la asignación.';
  }
}

async function cerrarSesion() {
  if (usuarioActual?.token) {
    try {
      await apiFetch(`${API_URL}/logout`, { method: 'POST' });
    } catch (err) {
      console.error('Error al revocar la sesión:', err);
    }
  }
  limpiarSesionLocal();
  mostrarToast('Sesión cerrada correctamente');
}

// --- GESTIÓN DE EMPLEADOS Y BUSCADOR ---

function fechaLocalActualISO() {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
}

function semanaInicioCuadrante() {
  const fechaReferencia = document.getElementById('fecha-semana-cuadrante')?.value || fechaLocalActualISO();
  return obtenerSemanaISO(fechaReferencia)[0];
}

function semanaCuadranteEsPasada() {
  return semanaInicioCuadrante() < obtenerSemanaISO(fechaLocalActualISO())[0];
}

function asegurarFechaSemanaCuadrante() {
  const selector = document.getElementById('fecha-semana-cuadrante');
  if (selector && !selector.value) selector.value = fechaLocalActualISO();
  actualizarEncabezadosSemana();
}

function formatearFechaCorta(fecha) {
  const [anio, mes, dia] = fecha.split('-');
  return `${dia}/${mes}/${anio}`;
}

function actualizarEncabezadosSemana() {
  const fechaReferencia = document.getElementById('fecha-semana-cuadrante')?.value || fechaLocalActualISO();
  const fechas = obtenerSemanaISO(fechaReferencia);
  fechas.forEach((fecha, indice) => {
    const elemento = document.getElementById(`fecha-cuadrante-${indice}`);
    if (elemento) elemento.textContent = formatearFechaCorta(fecha);
  });
  const resumen = document.getElementById('resumen-semana-cuadrante');
  if (resumen) {
    const notaPasada = fechas[0] < obtenerSemanaISO(fechaLocalActualISO())[0]
      ? ' Esta semana es de solo lectura.'
      : '';
    resumen.textContent = `Semana del ${formatearFechaCorta(fechas[0])} al ${formatearFechaCorta(fechas[6])}. Las ausencias solo reemplazan turnos en estas fechas.${notaPasada}`;
  }
  return fechas;
}

function cambiarSemanaCuadrante() {
  if (horariosListos) {
    renderizarCuadrante();
    actualizarAlertaCobertura();
  } else {
    actualizarEncabezadosSemana();
  }
}

async function cargarEmpleadosBD() {
  horariosListos = false;
  try {
    asegurarFechaSemanaCuadrante();
    const res = await apiFetch(`${API_URL}/empleados`);
    const datosEmpleados = await res.json();
    if (!res.ok) throw new Error(datosEmpleados.error || 'No se pudieron cargar los atendedores.');
    empleados = datosEmpleados;
    await cargarAusenciasBD(false);

    const resHorarios = await apiFetch(`${API_URL}/horarios`);
    const asignaciones = await resHorarios.json();
    if (!resHorarios.ok) throw new Error(asignaciones.error || 'No se pudieron cargar los horarios.');

    horarios = {};
    asignaciones.forEach(asignacion => {
      if (!horarios[asignacion.id_atendedor]) {
        horarios[asignacion.id_atendedor] = Array(7).fill(null);
      }
      horarios[asignacion.id_atendedor][asignacion.dia_semana] = asignacion.turno;
    });
    const horariosCargados = JSON.parse(JSON.stringify(horarios));

    actualizarHorarios();
    renderizarEmpleados();
    renderizarCuadrante();
    cargarSelectorAsistencia();

    const faltanHorarios = empleados.filter(emp => emp.activo).some(emp => {
      const turnosGuardados = horariosCargados[emp.id];
      return !Array.isArray(turnosGuardados) ||
        turnosGuardados.length !== 7 ||
        turnosGuardados.some(turno => !['mañana', 'tarde', 'noche', 'libre'].includes(turno));
    });
    if (faltanHorarios && usuarioActual?.rol === 'admin') {
      await guardarHorariosBD();
    }
    horariosListos = true;
    actualizarAlertaCobertura();
  } catch (err) {
    console.error('Error al cargar empleados:', err);
    actualizarAlertaCobertura();
    mostrarToast(err.message || 'No se pudieron cargar los horarios.');
  }
}

async function cargarAusenciasBD(actualizarHorario = true) {
  const res = await apiFetch(`${API_URL}/ausencias`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'No se pudieron cargar las novedades.');
  ausencias = data;
  cargarSelectorAusencia();
  renderizarAusencias();
  if (actualizarHorario && horariosListos) {
    renderizarCuadrante();
    actualizarAlertaCobertura();
  }
}

function cargarSelectorAusencia() {
  const selector = document.getElementById('ausencia-atendedor');
  if (!selector) return;
  const seleccionado = selector.value;
  selector.innerHTML = '';
  empleados.filter(empleado => Number(empleado.activo) === 1).forEach(empleado => {
    const opcion = document.createElement('option');
    opcion.value = empleado.id;
    opcion.textContent = empleado.nombre;
    selector.appendChild(opcion);
  });
  if (empleados.some(empleado => Number(empleado.id) === Number(seleccionado) && Number(empleado.activo) === 1)) {
    selector.value = seleccionado;
  }
}

function renderizarAusencias() {
  const tbody = document.getElementById('tabla-ausencias-body');
  if (!tbody) return;
  tbody.replaceChildren();

  if (ausencias.length === 0) {
    const fila = document.createElement('tr');
    const celda = document.createElement('td');
    celda.colSpan = 5;
    celda.className = 'p-3 text-center italic text-slate-400';
    celda.textContent = 'No hay licencias ni vacaciones registradas.';
    fila.appendChild(celda);
    tbody.appendChild(fila);
    return;
  }

  ausencias.forEach(ausencia => {
    const fila = document.createElement('tr');
    const tipo = ausencia.tipo === 'vacaciones'
      ? 'Vacaciones'
      : ausencia.tipo === 'dia_libre' ? 'Día libre aprobado' : 'Licencia médica';
    [
      ausencia.nombre_atendedor,
      tipo,
      `${formatearFechaCorta(ausencia.fecha_inicio)} - ${formatearFechaCorta(ausencia.fecha_termino)}`,
      ausencia.observacion || '—'
    ].forEach(valor => {
      const celda = document.createElement('td');
      celda.className = 'p-2';
      celda.textContent = valor;
      fila.appendChild(celda);
    });

    const acciones = document.createElement('td');
    acciones.className = 'p-2 text-center whitespace-nowrap';
    const editar = document.createElement('button');
    editar.type = 'button';
    editar.className = 'mr-2 font-semibold text-blue-700 hover:underline';
    editar.textContent = 'Editar';
    editar.addEventListener('click', () => editarAusencia(ausencia));
    const eliminar = document.createElement('button');
    eliminar.type = 'button';
    eliminar.className = 'font-semibold text-rose-700 hover:underline';
    eliminar.textContent = 'Eliminar';
    eliminar.addEventListener('click', () => eliminarAusencia(ausencia.id));
    acciones.append(editar, eliminar);
    fila.appendChild(acciones);
    tbody.appendChild(fila);
  });
}

function editarAusencia(ausencia) {
  if (usuarioActual?.rol !== 'admin') return;
  ausenciaEditandoId = Number(ausencia.id);
  document.getElementById('ausencia-atendedor').value = ausencia.id_atendedor;
  document.getElementById('ausencia-tipo').value = ausencia.tipo;
  document.getElementById('ausencia-inicio').value = ausencia.fecha_inicio;
  document.getElementById('ausencia-termino').value = ausencia.fecha_termino;
  document.getElementById('ausencia-observacion').value = ausencia.observacion || '';
  document.getElementById('btn-guardar-ausencia').textContent = 'Guardar cambios';
  document.getElementById('btn-cancelar-edicion-ausencia').classList.remove('hidden');
}

function cancelarEdicionAusencia() {
  ausenciaEditandoId = null;
  document.getElementById('form-ausencia')?.reset();
  document.getElementById('btn-guardar-ausencia').textContent = 'Registrar novedad';
  document.getElementById('btn-cancelar-edicion-ausencia').classList.add('hidden');
}

async function guardarAusencia(event) {
  event.preventDefault();
  if (usuarioActual?.rol !== 'admin') return;

  const datos = {
    id_atendedor: Number(document.getElementById('ausencia-atendedor').value),
    tipo: document.getElementById('ausencia-tipo').value,
    fecha_inicio: document.getElementById('ausencia-inicio').value,
    fecha_termino: document.getElementById('ausencia-termino').value,
    observacion: document.getElementById('ausencia-observacion').value.trim()
  };
  if (datos.fecha_termino < datos.fecha_inicio) {
    return alert('La fecha de término no puede ser anterior a la fecha de inicio.');
  }

  const estabaEditando = Boolean(ausenciaEditandoId);
  try {
    const url = ausenciaEditandoId
      ? `${API_URL}/ausencias/${ausenciaEditandoId}`
      : `${API_URL}/ausencias`;
    const res = await apiFetch(url, {
      method: ausenciaEditandoId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo guardar la novedad.');
    cancelarEdicionAusencia();
    try {
      await cargarAusenciasBD();
    } catch (err) {
      console.error('La novedad se guardó, pero no se pudo actualizar la vista:', err);
      alert('La novedad se guardó, pero no se pudo actualizar la lista. Recarga la página para ver los cambios.');
      return;
    }
    mostrarToast(estabaEditando ? 'Novedad actualizada' : 'Novedad registrada');
  } catch (err) {
    alert(err.message || 'No se pudo guardar la novedad.');
  }
}

async function eliminarAusencia(id) {
  if (usuarioActual?.rol !== 'admin') return;
  if (!confirm('¿Eliminar esta novedad? Los turnos volverán a mostrarse en sus fechas.')) return;

  try {
    const res = await apiFetch(`${API_URL}/ausencias/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo eliminar la novedad.');
    if (Number(ausenciaEditandoId) === Number(id)) cancelarEdicionAusencia();
    try {
      await cargarAusenciasBD();
    } catch (err) {
      console.error('La novedad se eliminó, pero no se pudo actualizar la vista:', err);
      alert('La novedad se eliminó, pero no se pudo actualizar la lista. Recarga la página para ver los cambios.');
      return;
    }
    mostrarToast('Novedad eliminada');
  } catch (err) {
    alert(err.message || 'No se pudo eliminar la novedad.');
  }
}

function renderizarEmpleados(listaFiltro = null) {
  const tbody = document.getElementById('tabla-empleados-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const listaAMostrar = listaFiltro || empleados;

  if (listaAMostrar.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="3" class="p-4 text-center text-slate-400 italic">
          No se encontraron atendedores que coincidan con la búsqueda.
        </td>
      </tr>
    `;
    return;
  }

  listaAMostrar.forEach(e => {
    const activo = Boolean(e.activo);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="p-2">
        <div class="font-bold text-slate-800">${e.nombre}</div>
        <div class="mt-0.5 font-mono text-[10px] text-slate-500">${e.rut}</div>
        <div class="mt-0.5 break-all text-[10px] text-slate-500">${e.email || 'Sin correo'}</div>
      </td>
      <td class="p-2">
        ${!activo
          ? '<span class="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-[11px] font-bold border border-slate-300">Archivado</span>'
          : e.licencia
          ? '<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded text-[11px] font-bold border border-amber-300">Licencia sin fechas (registro anterior)</span>'
          : '<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded text-[11px] font-bold border border-emerald-300">Activo</span>'
        }
      </td>
      <td class="p-2">
        <div class="flex flex-wrap justify-center gap-1">
          <button onclick="editarEmpleado(${e.id})" class="text-[11px] bg-slate-100 hover:bg-slate-200 border px-2 py-1 rounded font-medium transition">
            Editar
          </button>
          ${activo && e.licencia ? `<button onclick="toggleLicencia(${e.id})" class="text-[11px] bg-slate-100 hover:bg-slate-200 border px-2 py-1 rounded font-medium transition">
            Quitar licencia sin fechas
          </button>` : ''}
          <button onclick="cambiarEstadoEmpleado(${e.id}, ${!activo})" class="text-[11px] ${activo ? 'text-rose-700' : 'text-emerald-700'} hover:underline p-1 rounded transition">
            ${activo ? 'Archivar' : 'Reactivar'}
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  lucide.createIcons();
}

// Función de filtro dinámico para la Lupa
function filtrarEmpleados() {
  const textoInput = document.getElementById('input-buscar-empleado').value.toLowerCase().trim();
  const empleadosFiltrados = empleados.filter(e => 
    e.nombre.toLowerCase().includes(textoInput) || 
    e.rut.toLowerCase().includes(textoInput)
  );
  renderizarEmpleados(empleadosFiltrados);
}

function agregarEmpleadoModal() {
  if (usuarioActual.rol !== 'admin') {
    return alert('Acceso denegado: Solo administradores pueden agregar personal.');
  }

  abrirModalAtendedor();
}

function abrirModalAtendedor(empleado = null) {
  const form = document.getElementById('form-atendedor');
  const dialog = document.getElementById('modal-atendedor');
  const editando = empleado !== null;
  const password = document.getElementById('atendedor-password');
  empleadoEditandoId = editando ? empleado.id : null;
  form.reset();
  document.getElementById('atendedor-error').classList.add('hidden');
  document.getElementById('titulo-modal-atendedor').textContent = editando ? 'Editar atendedor' : 'Agregar atendedor';
  document.getElementById('descripcion-modal-atendedor').textContent = editando
    ? 'Actualiza los datos del atendedor.'
    : 'Completa los datos para crear su cuenta y agregarlo a la nómina.';
  document.getElementById('grupo-password-atendedor').classList.toggle('hidden', editando);
  password.required = !editando;
  document.getElementById('btn-guardar-atendedor').textContent = editando ? 'Guardar cambios' : 'Guardar atendedor';
  if (editando) {
    document.getElementById('atendedor-nombre').value = empleado.nombre;
    document.getElementById('atendedor-rut').value = empleado.rut;
    document.getElementById('atendedor-email').value = empleado.email || '';
  }
  dialog.showModal();
  document.getElementById('atendedor-nombre').focus();
}

function cerrarModalAtendedor() {
  const dialog = document.getElementById('modal-atendedor');
  if (dialog.open) dialog.close();
  empleadoEditandoId = null;
  document.getElementById('form-atendedor').reset();
  document.getElementById('atendedor-error').classList.add('hidden');
  document.getElementById('titulo-modal-atendedor').textContent = 'Agregar atendedor';
  document.getElementById('descripcion-modal-atendedor').textContent = 'Completa los datos para crear su cuenta y agregarlo a la nómina.';
  document.getElementById('grupo-password-atendedor').classList.remove('hidden');
  document.getElementById('atendedor-password').required = true;
  document.getElementById('btn-guardar-atendedor').textContent = 'Guardar atendedor';
}

async function guardarAtendedor(event) {
  event.preventDefault();
  if (usuarioActual?.rol !== 'admin') {
    return alert('Acceso denegado: Solo administradores pueden agregar personal.');
  }

  const editando = empleadoEditandoId !== null;
  const nombre = document.getElementById('atendedor-nombre').value.trim();
  const rut = document.getElementById('atendedor-rut').value.trim();
  const email = document.getElementById('atendedor-email').value.trim();
  const password = document.getElementById('atendedor-password').value;
  const error = document.getElementById('atendedor-error');
  const button = document.getElementById('btn-guardar-atendedor');

  if (!editando && !esContrasenaSegura(password)) {
    error.textContent = 'La contraseña debe tener entre 8 y 128 caracteres e incluir mayúscula, minúscula, número y símbolo.';
    error.classList.remove('hidden');
    return;
  }

  button.disabled = true;
  button.textContent = 'Guardando...';
  try {
    const body = { rut, nombre, email };
    if (!editando) body.password = password;
    const res = await apiFetch(`${API_URL}/empleados${editando ? `/${empleadoEditandoId}` : ''}`, {
      method: editando ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      error.textContent = data.error || 'No se pudo guardar el atendedor.';
      error.classList.remove('hidden');
      return;
    }

    cerrarModalAtendedor();
    await cargarEmpleadosBD();
    mostrarToast(editando ? 'Datos del atendedor actualizados' : `Atendedor agregado: ${email}`);
  } catch (err) {
    console.error(editando ? 'Error al editar atendedor:' : 'Error al agregar atendedor:', err);
    error.textContent = 'No se pudo conectar con el servidor.';
    error.classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = empleadoEditandoId === null ? 'Guardar atendedor' : 'Guardar cambios';
  }
}

async function toggleLicencia(id) {
  if (usuarioActual.rol !== 'admin') {
    return alert('Acceso denegado: Solo administradores pueden modificar licencias.');
  }

  const emp = empleados.find(e => e.id === id);
  if (!emp) return;

  const nuevoEstado = !emp.licencia;

  try {
    const res = await apiFetch(`${API_URL}/empleados/${id}/licencia`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licencia: nuevoEstado })
    });

    const data = await res.json();

    if (data.success) {
      emp.licencia = nuevoEstado;
      renderizarEmpleados();
      renderizarCuadrante();
      mostrarToast('Licencia actualizada en MariaDB');
    } else {
      alert('Error al actualizar la licencia');
    }
  } catch (err) {
    console.error('Error al actualizar licencia:', err);
    alert('Error de conexión.');
  }
}

async function editarEmpleado(id) {
  if (usuarioActual.rol !== 'admin') {
    return alert('Acceso denegado: Solo administradores pueden editar personal.');
  }

  const emp = empleados.find(e => e.id === id);
  if (!emp) return;
  abrirModalAtendedor(emp);
}

async function cambiarEstadoEmpleado(id, activo) {
  if (usuarioActual.rol !== 'admin') return alert('Acceso denegado');
  const accion = activo ? 'reactivar' : 'archivar';
  if (!confirm(`¿Quieres ${accion} este atendedor? Sus registros históricos se conservarán.`)) return;

  try {
    const res = await apiFetch(`${API_URL}/empleados/${id}${activo ? '/estado' : ''}`, {
      method: activo ? 'PUT' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      ...(activo ? { body: JSON.stringify({ activo: true }) } : {})
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || `No se pudo ${accion} el atendedor.`);
    await cargarEmpleadosBD();
    mostrarToast(activo ? 'Atendedor reactivado' : 'Atendedor archivado');
  } catch (err) {
    console.error(`Error al ${accion} atendedor:`, err);
    alert('No se pudo conectar con el servidor.');
  }
}

// --- GESTIÓN DE ADMINISTRADORES ---

async function cargarAdministradoresBD() {
  if (!usuarioActual || usuarioActual.rol !== 'admin') return;

  try {
    const res = await apiFetch(`${API_URL}/administradores`);
    administradores = await res.json();
    renderizarAdministradores();
  } catch (err) {
    console.error('Error al cargar administradores:', err);
  }
}

function renderizarAdministradores() {
  const tbody = document.getElementById('tabla-admins-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (administradores.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400 italic">No hay administradores registrados.</td></tr>`;
    return;
  }

  administradores.forEach(adm => {
    const activo = Boolean(adm.activo);
    const esGeneral = Boolean(adm.es_general);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="p-3 font-mono">${adm.rut}</td>
      <td class="p-3 font-bold">${adm.nombre}</td>
      <td class="p-3 text-slate-600">${adm.email}</td>
      <td class="p-3">${adm.departamento}</td>
      <td class="p-3">${esGeneral ? 'Administrador general' : activo ? 'Activo' : 'Archivado'}</td>
      <td class="p-3 text-center">
        <button onclick="editarAdministrador(${adm.id})" class="text-slate-700 hover:underline p-1 rounded transition text-xs font-semibold">
          Editar
        </button>
        ${esGeneral
          ? '<span class="px-1 text-[11px] font-semibold text-slate-400" title="La cuenta del administrador general está protegida">Protegida</span>'
          : `<button onclick="cambiarEstadoAdministrador(${adm.id}, ${!activo})" class="${activo ? 'text-rose-700' : 'text-emerald-700'} hover:underline p-1 rounded transition text-xs font-semibold">
          ${activo ? 'Archivar' : 'Reactivar'}
        </button>`}
      </td>
    `;
    tbody.appendChild(tr);
  });
  lucide.createIcons();
}

function agregarAdministradorModal() {
  if (usuarioActual?.rol !== 'admin') return alert('Acceso denegado');

  administradorEditandoId = null;
  document.getElementById('form-administrador').reset();
  document.getElementById('titulo-modal-administrador').textContent = 'Agregar administrador';
  document.getElementById('descripcion-modal-administrador').textContent =
    'Completa los datos para crear una cuenta administradora.';
  document.getElementById('btn-guardar-administrador').textContent = 'Guardar administrador';
  document.getElementById('grupo-password-administrador').classList.remove('hidden');
  document.getElementById('administrador-password').required = true;
  document.getElementById('administrador-error').classList.add('hidden');
  document.getElementById('modal-administrador').showModal();
}

function cerrarModalAdministrador() {
  const modal = document.getElementById('modal-administrador');
  if (modal.open) modal.close();
  document.getElementById('form-administrador').reset();
  document.getElementById('grupo-password-administrador').classList.remove('hidden');
  document.getElementById('administrador-password').required = true;
  document.getElementById('administrador-error').classList.add('hidden');
  administradorEditandoId = null;
}

async function guardarAdministrador(event) {
  event.preventDefault();
  if (usuarioActual?.rol !== 'admin') return alert('Acceso denegado');

  const errorEl = document.getElementById('administrador-error');
  const nombre = document.getElementById('administrador-nombre').value.trim();
  const rut = document.getElementById('administrador-rut').value.trim();
  const email = document.getElementById('administrador-email').value.trim();
  const departamento = document.getElementById('administrador-departamento').value.trim();
  const password = document.getElementById('administrador-password').value;
  const editando = administradorEditandoId !== null;

  if (!editando && !esContrasenaSegura(password)) {
    errorEl.textContent = 'La contraseña debe tener entre 8 y 128 caracteres e incluir mayúscula, minúscula, número y símbolo.';
    errorEl.classList.remove('hidden');
    return;
  }

  const datos = { nombre, rut, email, departamento };
  if (!editando) datos.password = password;

  try {
    const res = await apiFetch(
      `${API_URL}/administradores${editando ? `/${administradorEditandoId}` : ''}`,
      {
        method: editando ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(datos)
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo guardar el administrador.');

    cerrarModalAdministrador();
    mostrarToast(editando ? 'Administrador actualizado' : 'Administrador registrado con éxito');
    await cargarAdministradoresBD();
  } catch (err) {
    console.error('Error al guardar administrador:', err);
    errorEl.textContent = err.message || 'No se pudo conectar con el servidor.';
    errorEl.classList.remove('hidden');
  }
}

async function editarAdministrador(id) {
  if (usuarioActual?.rol !== 'admin') return alert('Acceso denegado');
  const admin = administradores.find(item => item.id === id);
  if (!admin) return;
  administradorEditandoId = id;
  document.getElementById('administrador-nombre').value = admin.nombre;
  document.getElementById('administrador-rut').value = admin.rut;
  document.getElementById('administrador-email').value = admin.email;
  document.getElementById('administrador-departamento').value = admin.departamento;
  document.getElementById('administrador-password').value = '';
  document.getElementById('administrador-password').required = false;
  document.getElementById('grupo-password-administrador').classList.add('hidden');
  document.getElementById('titulo-modal-administrador').textContent = 'Editar administrador';
  document.getElementById('descripcion-modal-administrador').textContent =
    'Actualiza los datos de la cuenta administradora.';
  document.getElementById('btn-guardar-administrador').textContent = 'Guardar cambios';
  document.getElementById('administrador-error').classList.add('hidden');
  document.getElementById('modal-administrador').showModal();
}

async function cambiarEstadoAdministrador(id, activo) {
  if (usuarioActual.rol !== 'admin') return alert('Acceso denegado');
  const accion = activo ? 'reactivar' : 'archivar';
  if (!confirm(`¿Quieres ${accion} este administrador? Sus registros históricos se conservarán.`)) return;

  try {
    const res = await apiFetch(`${API_URL}/administradores/${id}${activo ? '/estado' : ''}`, {
      method: activo ? 'PUT' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      ...(activo ? { body: JSON.stringify({ activo: true }) } : {})
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || `No se pudo ${accion} el administrador.`);
    mostrarToast(activo ? 'Administrador reactivado' : 'Administrador archivado');
    await cargarAdministradoresBD();
  } catch (err) {
    console.error(`Error al ${accion} administrador:`, err);
    alert('Error de conexión.');
  }
}

async function cargarSolicitudesDesbloqueo() {
  if (usuarioActual?.rol !== 'admin') return;

  try {
    const res = await apiFetch(`${API_URL}/solicitudes-desbloqueo`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron cargar las solicitudes.');
    renderizarSolicitudesDesbloqueo(data);
  } catch (err) {
    console.error('Error al cargar solicitudes de desbloqueo:', err);
    const tbody = document.getElementById('tabla-desbloqueos-body');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-rose-600">No se pudieron cargar las solicitudes de desbloqueo.</td></tr>';
    }
  }
}

function renderizarSolicitudesDesbloqueo(solicitudesDesbloqueo) {
  const tbody = document.getElementById('tabla-desbloqueos-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (solicitudesDesbloqueo.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-400 italic">No hay solicitudes de desbloqueo.</td></tr>';
    return;
  }

  solicitudesDesbloqueo.forEach(solicitud => {
    const tr = document.createElement('tr');
    [solicitud.nombre, solicitud.email, solicitud.fecha_creacion, solicitud.estado].forEach((value, index) => {
      const td = document.createElement('td');
      td.className = index === 0 ? 'p-3 font-bold' : 'p-3';
      td.textContent = value || '';
      tr.appendChild(td);
    });

    const tdAcciones = document.createElement('td');
    tdAcciones.className = 'p-3 text-center';
    if (solicitud.estado === 'Pendiente') {
      [['Aprobar', 'Aprobada', 'text-emerald-700 hover:text-emerald-900 mr-2'], ['Rechazar', 'Rechazada', 'text-rose-700 hover:text-rose-900']].forEach(([label, estado, className]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `${className} font-bold`;
        button.textContent = label;
        button.onclick = () => responderSolicitudDesbloqueo(solicitud.id_solicitud, estado);
        tdAcciones.appendChild(button);
      });
    }
    tr.appendChild(tdAcciones);
    tbody.appendChild(tr);
  });
}

async function responderSolicitudDesbloqueo(id, estado) {
  if (usuarioActual?.rol !== 'admin') return;

  try {
    const res = await apiFetch(`${API_URL}/solicitudes-desbloqueo/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'No se pudo responder la solicitud.');
      return;
    }
    mostrarToast(estado === 'Aprobada' ? 'Cuenta desbloqueada' : 'Solicitud rechazada');
    await cargarSolicitudesDesbloqueo();
  } catch (err) {
    console.error('Error al responder solicitud de desbloqueo:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

// --- GESTIÓN DE TURNOS Y CUADRANTE ---

async function cargarParametrosTemporada() {
  try {
    const res = await apiFetch(`${API_URL}/parametros-temporada`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron cargar los parámetros por temporada.');
    parametrosTemporada = data;
    actualizarControlesTemporada();
    if (horariosListos) renderizarCuadrante();
  } catch (err) {
    console.error('Error al cargar parámetros por temporada:', err);
  }
}

async function cargarParametrosCobertura() {
  parametrosCoberturaCargados = false;
  errorParametrosCobertura = '';
  try {
    const res = await apiFetch(`${API_URL}/parametros-cobertura`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron cargar los mínimos de cobertura.');
    if (!['manana', 'tarde', 'noche'].every(turno =>
      Number.isInteger(data[turno]) && data[turno] >= 1 && data[turno] <= 500
    )) {
      throw new Error('La configuración de cobertura recibida no es válida.');
    }

    parametrosCobertura = data;
    parametrosCoberturaCargados = true;
    errorParametrosCobertura = '';
    actualizarControlesCobertura();
    actualizarAlertaCobertura();
  } catch (err) {
    parametrosCoberturaCargados = false;
    errorParametrosCobertura = err.message || 'No se pudieron cargar los mínimos de cobertura.';
    console.error('Error al cargar mínimos de cobertura:', err);
    mostrarErrorCobertura(errorParametrosCobertura);
  }
}

function actualizarControlesCobertura() {
  const manana = document.getElementById('cobertura-manana');
  const tarde = document.getElementById('cobertura-tarde');
  const noche = document.getElementById('cobertura-noche');
  if (manana) manana.value = parametrosCobertura.manana;
  if (tarde) tarde.value = parametrosCobertura.tarde;
  if (noche) noche.value = parametrosCobertura.noche;
}

async function guardarParametrosCobertura(event) {
  event.preventDefault();
  if (usuarioActual?.rol !== 'admin') return;

  const nuevosParametros = {
    manana: Number(document.getElementById('cobertura-manana').value),
    tarde: Number(document.getElementById('cobertura-tarde').value),
    noche: Number(document.getElementById('cobertura-noche').value)
  };
  if (!Object.values(nuevosParametros).every(minimo =>
    Number.isInteger(minimo) && minimo >= 1 && minimo <= 500
  )) {
    return mostrarErrorCobertura('Cada mínimo debe ser un número entero entre 1 y 500.');
  }

  try {
    const res = await apiFetch(`${API_URL}/parametros-cobertura`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nuevosParametros)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron guardar los mínimos de cobertura.');

    parametrosCobertura = data;
    parametrosCoberturaCargados = true;
    errorParametrosCobertura = '';
    actualizarControlesCobertura();
    actualizarAlertaCobertura();
    mostrarToast('Mínimos de cobertura guardados');
  } catch (err) {
    console.error('Error al guardar mínimos de cobertura:', err);
    mostrarErrorCobertura(err.message || 'No se pudieron guardar los mínimos de cobertura.');
  }
}

function obtenerInsuficienciasCobertura() {
  const turnos = [
    { nombre: 'Mañana', valor: 'mañana', minimo: parametrosCobertura.manana },
    { nombre: 'Tarde', valor: 'tarde', minimo: parametrosCobertura.tarde },
    { nombre: 'Noche', valor: 'noche', minimo: parametrosCobertura.noche }
  ];
  const insuficiencias = [];
  const fechasSemana = actualizarEncabezadosSemana();
  DIAS.forEach((dia, diaIndex) => {
    turnos.forEach(turno => {
      const asignados = empleados.reduce((total, empleado) => {
        if (!empleado.activo || empleado.licencia ||
            buscarAusenciaEnFecha(ausencias, empleado.id, fechasSemana[diaIndex])) return total;
        return total + (horarios[empleado.id]?.[diaIndex] === turno.valor ? 1 : 0);
      }, 0);
      if (asignados < turno.minimo) {
        insuficiencias.push({
          dia,
          fecha: fechasSemana[diaIndex],
          turno: turno.nombre,
          asignados,
          minimo: turno.minimo
        });
      }
    });
  });
  return insuficiencias;
}

function actualizarAlertaCobertura() {
  const alerta = document.getElementById('alerta-cobertura');
  if (!alerta) return;
  if (usuarioActual?.rol !== 'admin' || !horariosListos) {
    alerta.classList.add('hidden');
    return;
  }
  if (!parametrosCoberturaCargados) {
    if (errorParametrosCobertura) mostrarErrorCobertura(errorParametrosCobertura);
    else alerta.classList.add('hidden');
    return;
  }

  const insuficiencias = obtenerInsuficienciasCobertura();
  alerta.textContent = '';
  alerta.classList.remove('hidden');
  const encabezado = document.createElement('p');
  encabezado.className = 'font-bold';

  if (insuficiencias.length > 0) {
    alerta.className = 'rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800';
    alerta.setAttribute('role', 'alert');
    encabezado.textContent = `Cobertura insuficiente en ${insuficiencias.length} combinación(es) de día y turno:`;
    alerta.appendChild(encabezado);

    const lista = document.createElement('ul');
    lista.className = 'mt-1 list-disc pl-5';
    insuficiencias.forEach(({ dia, fecha, turno, asignados, minimo }) => {
      const elemento = document.createElement('li');
      elemento.textContent = `${dia} ${formatearFechaCorta(fecha)} — ${turno}: ${asignados}/${minimo} atendedores`;
      lista.appendChild(elemento);
    });
    alerta.appendChild(lista);
    return;
  }

  alerta.className = 'rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-800';
  alerta.setAttribute('role', 'status');
  encabezado.textContent = 'Cobertura suficiente: todos los días cumplen los mínimos configurados.';
  alerta.appendChild(encabezado);
}

function mostrarErrorCobertura(mensaje) {
  const alerta = document.getElementById('alerta-cobertura');
  if (!alerta) return;
  alerta.className = 'rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800';
  alerta.setAttribute('role', 'alert');
  alerta.textContent = mensaje;
  alerta.classList.remove('hidden');
}

function obtenerHorasMinimasActuales() {
  return parametrosTemporada.modo === 'verano'
    ? parametrosTemporada.horas_minimas_verano
    : parametrosTemporada.horas_minimas_normal;
}

function obtenerEtiquetaTurno(turno) {
  if (turno === 'libre') return 'Libre';
  const horas = obtenerHorasMinimasActuales();
  const horario = calcularHorarioTurno(TURNOS_INICIO[turno], horas);
  const nombre = turno.charAt(0).toUpperCase() + turno.slice(1);
  return `${nombre} (${horario.inicio}-${horario.fin}, ${horas} h)`;
}

function actualizarControlesTemporada() {
  const modo = document.getElementById('temporada-modo');
  const normal = document.getElementById('temporada-horas-normal');
  const verano = document.getElementById('temporada-horas-verano');
  const estado = document.getElementById('temporada-estado');
  const avisoSolapamiento = document.getElementById('aviso-solapamiento-temporada');
  const esAdmin = usuarioActual?.rol === 'admin';
  const horas = obtenerHorasMinimasActuales();
  const solapamiento = Math.max(0, horas - 8);

  if (modo) modo.value = parametrosTemporada.modo;
  if (normal) normal.value = parametrosTemporada.horas_minimas_normal;
  if (verano) verano.value = parametrosTemporada.horas_minimas_verano;

  if (estado) {
    estado.textContent = `Modo ${parametrosTemporada.modo === 'verano' ? 'Verano' : 'Normal'}: ${horas} h por turno`;
  }
  if (avisoSolapamiento) {
    avisoSolapamiento.textContent = `Los turnos se solapan ${solapamiento} h para cumplir la duración seleccionada.`;
    avisoSolapamiento.classList.toggle('hidden', solapamiento === 0);
  }

  document.querySelectorAll('[data-temporada-admin]').forEach(elemento => {
    elemento.classList.toggle('hidden', !esAdmin);
  });

  document.querySelectorAll('[data-turno-horario]').forEach(elemento => {
    const turno = elemento.dataset.turnoHorario;
    const horario = calcularHorarioTurno(TURNOS_INICIO[turno], horas);
    elemento.textContent = `(${horario.inicio}-${horario.fin}, ${horas} h)`;
  });
}

async function guardarParametrosTemporada(event) {
  event.preventDefault();
  if (usuarioActual?.rol !== 'admin') return;

  const modo = document.getElementById('temporada-modo')?.value || 'normal';
  const normal = Number(document.getElementById('temporada-horas-normal')?.value);
  const verano = Number(document.getElementById('temporada-horas-verano')?.value);

  if (!Number.isInteger(normal) || normal < 8 || normal > 12 ||
      !Number.isInteger(verano) || verano < 8 || verano > 12) {
    return alert('La duración de cada turno debe ser un número entero entre 8 y 12 horas.');
  }

  try {
    const res = await apiFetch(`${API_URL}/parametros-temporada`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modo,
        horas_minimas_normal: normal,
        horas_minimas_verano: verano
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron guardar los parámetros.');

    parametrosTemporada = data;
    actualizarControlesTemporada();
    if (horariosListos) renderizarCuadrante();
    mostrarToast(data.notificaciones
      ? `Modo ${modo === 'verano' ? 'Verano' : 'Normal'} aplicado; atendedores notificados.`
      : `Modo ${modo === 'verano' ? 'Verano' : 'Normal'} guardado.`);
  } catch (err) {
    alert(err.message || 'No se pudieron guardar los parámetros por temporada.');
  }
}

function actualizarHorarios() {
  const opciones = ['mañana', 'tarde', 'noche', 'libre'];
  empleados.forEach(emp => {
    if (!emp.activo) return;
    const turnos = horarios[emp.id];
    if (!Array.isArray(turnos) ||
        turnos.length !== 7 ||
        turnos.some(turno => !opciones.includes(turno))) {
      horarios[emp.id] = DIAS.map((_, dia) => opciones[(Number(emp.id) + dia) % opciones.length]);
    }
  });
}

function guardarHorariosBD(notificacion = null) {
  if (semanaCuadranteEsPasada()) {
    return Promise.reject(new Error('No se pueden modificar horarios de semanas pasadas.'));
  }
  const semanaInicio = semanaInicioCuadrante();
  const datosHorarios = empleados.filter(emp => emp.activo).map(emp => ({
    id_atendedor: emp.id,
    turnos: [...(horarios[emp.id] || [])]
  }));
  const guardar = colaGuardadoHorarios.then(async () => {
    const cuerpo = { horarios: datosHorarios, semanaInicio };
    if (notificacion) cuerpo.notificacion = notificacion;
    const res = await apiFetch(`${API_URL}/horarios`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron guardar los horarios.');
    return data;
  });
  colaGuardadoHorarios = guardar.catch(err => {
    console.error('Error al guardar los horarios:', err);
  });
  return guardar;
}

function renderizarCuadrante() {
  const tbody = document.getElementById('tabla-turnos-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  const fechasSemana = actualizarEncabezadosSemana();

  const esAdmin = usuarioActual && usuarioActual.rol === 'admin';
  const empleadosAMostrar = esAdmin
    ? empleados.filter(emp => emp.activo)
    : empleados.filter(emp =>
        Number(emp.id_usuario) === Number(usuarioActual?.id) ||
        (emp.email && emp.email.toLowerCase() === usuarioActual?.email?.toLowerCase())
      );

  empleadosAMostrar.forEach(emp => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50 transition';

    let htmlCells = `<td class="p-3 border-r border-slate-200">
      <div class="font-bold text-slate-800">${emp.nombre}</div>
      ${emp.licencia ? '<span class="text-[10px] text-amber-600 font-semibold block">Incapacidad / Licencia</span>' : ''}
    </td>`;

    DIAS.forEach((_, dIdx) => {
      const tActual = (horarios[emp.id] || [])[dIdx] || 'libre';
      const ausencia = buscarAusenciaEnFecha(ausencias, emp.id, fechasSemana[dIdx]);
      if (emp.licencia || ausencia) {
        const motivo = emp.licencia
          ? 'Licencia sin fechas'
          : ausencia.tipo === 'vacaciones'
            ? 'Vacaciones'
            : ausencia.tipo === 'dia_libre' ? 'Día libre aprobado' : 'Licencia médica';
        htmlCells += `<td class="p-2 text-center border-r border-slate-100 bg-amber-50 text-amber-800 italic text-[11px]">${motivo}<br>${formatearFechaCorta(fechasSemana[dIdx])}</td>`;
      } else {
        if (esAdmin) {
          htmlCells += `
            <td class="p-1.5 border-r border-slate-100">
                <select onchange="cambiarTurnoManual(${emp.id}, ${dIdx}, this.value)" ${semanaCuadranteEsPasada() ? 'disabled title="Las semanas pasadas son de solo lectura."' : ''}
                class="w-full text-xs p-1.5 rounded border transition cursor-pointer ${TURNOS_ESTILOS[tActual]}">
                <option value="mañana" ${tActual === 'mañana' ? 'selected' : ''}>${obtenerEtiquetaTurno('mañana')}</option>
                <option value="tarde" ${tActual === 'tarde' ? 'selected' : ''}>${obtenerEtiquetaTurno('tarde')}</option>
                <option value="noche" ${tActual === 'noche' ? 'selected' : ''}>${obtenerEtiquetaTurno('noche')}</option>
                <option value="libre" ${tActual === 'libre' ? 'selected' : ''}>${obtenerEtiquetaTurno('libre')}</option>
              </select>
            </td>
          `;
        } else {
          const formatoNombre = obtenerEtiquetaTurno(tActual);
          htmlCells += `
            <td class="p-2 text-center border-r border-slate-100">
              <span class="inline-block w-full py-1 text-xs rounded border ${TURNOS_ESTILOS[tActual]}">
                ${formatoNombre}
              </span>
            </td>
          `;
        }
      }
    });

    tr.innerHTML = htmlCells;
    tbody.appendChild(tr);
  });
  actualizarAlertaCobertura();
}

async function cambiarTurnoManual(empId, dIdx, nuevoTurno) {
  if (usuarioActual.rol !== 'admin') return;
  if (semanaCuadranteEsPasada()) return alert('No se pueden modificar horarios de semanas pasadas.');
  if (!horarios[empId] || dIdx < 0 || dIdx > 6) return;
  const fechasSemana = obtenerSemanaISO(document.getElementById('fecha-semana-cuadrante')?.value || fechaLocalActualISO());
  const empleado = empleados.find(item => Number(item.id) === Number(empId));
  if (empleado?.licencia || buscarAusenciaEnFecha(ausencias, empId, fechasSemana[dIdx])) {
    return alert('No se puede asignar un turno durante una licencia o vacaciones.');
  }

  horarios[empId][dIdx] = nuevoTurno;
  renderizarCuadrante();
  try {
    await guardarHorariosBD('cambio');
    mostrarToast('Turno guardado correctamente');
  } catch (err) {
    alert(err.message || 'El turno cambió en pantalla, pero no se pudo guardar.');
  }
}

async function generarTurnosAuto() {
  if (usuarioActual.rol !== 'admin') return;
  if (semanaCuadranteEsPasada()) return alert('No se pueden generar horarios para semanas pasadas.');
  if (!horariosListos) return alert('Espera a que se carguen los horarios antes de generarlos.');
  if (!parametrosCoberturaCargados) return alert('No se pudieron cargar los mínimos de cobertura.');

  try {
    const semanaInicio = semanaInicioCuadrante();
    const resHistorial = await apiFetch(`${API_URL}/historial-turnos?semanaInicio=${encodeURIComponent(semanaInicio)}`);
    const historial = await resHistorial.json();
    if (!resHistorial.ok) throw new Error(historial.error || 'No se pudo cargar el historial de turnos.');
    const horariosGenerados = generarTurnosEquitativos(empleados, parametrosCobertura, {
      semanaInicio,
      historial
    });
    Object.assign(horarios, horariosGenerados);
    renderizarCuadrante();
    await guardarHorariosBD('publicacion');
    const insuficiencias = obtenerInsuficienciasCobertura();
    const temporada = parametrosTemporada.modo === 'verano' ? 'Modo Verano' : 'Modo Normal';
    mostrarToast(insuficiencias.length
      ? `Horario guardado (${temporada}) con ${insuficiencias.length} déficits; revisa la alerta.`
      : `Horario generado y guardado (${temporada}); todos los mínimos se cumplen.`);
  } catch (err) {
    console.error('Error al generar y guardar los turnos:', err);
    alert(err.message || 'No se pudieron generar y guardar los turnos.');
  }
}

// --- GESTIÓN DE ASISTENCIA ---

async function guardarAsistencia(e) {
  e.preventDefault();
  if (usuarioActual?.rol !== 'admin') return;

  const empId = Number(document.getElementById('asist-emp').value);
  const fecha = document.getElementById('asist-fecha').value;
  const origen = document.getElementById('asist-origen').value.trim();
  const ordinarias = Number(document.getElementById('asist-ord').value);
  const extras = Number(document.getElementById('asist-ext').value);

  try {
    const res = await apiFetch(`${API_URL}/asistencia`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id_atendedor: empId,
        fecha,
        horas_normales: ordinarias,
        horas_extras: extras,
        origen_registro: origen
      })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'No se pudo guardar el registro de asistencia.');
      return;
    }

    e.target.reset();
    document.getElementById('asist-fecha').valueAsDate = new Date();
    document.getElementById('asist-origen').value = 'Libro físico';
    await cargarAsistenciasBD();
    mostrarToast('Registro de asistencia guardado');
  } catch (err) {
    console.error('Error al guardar asistencia:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

async function cargarAsistenciasBD() {
  if (usuarioActual?.rol !== 'admin') return;

  try {
    const res = await apiFetch(`${API_URL}/asistencia`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron cargar los registros.');
    asistencias = data;
    renderizarAsistencias();
  } catch (err) {
    console.error('Error al cargar asistencia:', err);
    const tbody = document.getElementById('tabla-asistencia-body');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-rose-600">No se pudieron cargar los registros de asistencia.</td></tr>';
    }
  }
}

function renderizarAsistencias() {
  const tbody = document.getElementById('tabla-asistencia-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (asistencias.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-slate-400 italic">No hay registros de asistencia.</td></tr>';
    return;
  }

  asistencias.forEach(a => {
    const anulado = Boolean(a.anulado);
    const tr = document.createElement('tr');
    tr.className = anulado ? 'bg-slate-50 text-slate-400' : 'hover:bg-slate-50';
    [
      [a.fecha, 'p-3 font-medium text-slate-600'],
      [a.nombre, 'p-3 font-bold'],
      [`${a.ordinarias} hrs`, 'p-3'],
      [`+${a.extras} hrs`, 'p-3 font-bold text-emerald-600'],
      [a.origen, 'p-3 text-slate-500'],
      [anulado ? 'Anulado' : 'Vigente', 'p-3']
    ].forEach(([value, className]) => {
      const td = document.createElement('td');
      td.className = className;
      td.textContent = value == null ? '' : String(value);
      tr.appendChild(td);
    });
    const tdAcciones = document.createElement('td');
    tdAcciones.className = 'p-3 text-center whitespace-nowrap';
    if (anulado) {
      tdAcciones.innerHTML = `
        <button onclick="restaurarAsistencia(${a.id})" class="text-emerald-700 hover:underline font-semibold">Restaurar</button>
      `;
    } else {
      tdAcciones.innerHTML = `
        <button onclick="editarAsistencia(${a.id})" class="text-blue-700 hover:underline font-semibold mr-2">Editar</button>
        <button onclick="anularAsistencia(${a.id})" class="text-rose-700 hover:underline font-semibold">Anular</button>
      `;
    }
    tr.appendChild(tdAcciones);
    tbody.appendChild(tr);
  });
}

async function editarAsistencia(id) {
  if (usuarioActual?.rol !== 'admin') return;
  const registro = asistencias.find(item => item.id === id);
  if (!registro || registro.anulado) return;

  const fecha = prompt('Fecha (AAAA-MM-DD):', registro.fecha);
  if (fecha === null) return;
  const ordinarias = prompt('Horas ordinarias:', registro.ordinarias);
  if (ordinarias === null) return;
  const extras = prompt('Horas extra:', registro.extras);
  if (extras === null) return;
  const origen = prompt('Origen del registro:', registro.origen);
  if (origen === null) return;

  try {
    const res = await apiFetch(`${API_URL}/asistencia/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fecha,
        horas_normales: ordinarias,
        horas_extras: extras,
        origen_registro: origen
      })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'No se pudo actualizar la asistencia.');
    await cargarAsistenciasBD();
    mostrarToast('Registro de asistencia actualizado');
  } catch (err) {
    console.error('Error al editar asistencia:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

async function anularAsistencia(id) {
  if (usuarioActual?.rol !== 'admin') return;
  if (!confirm('¿Quieres anular este registro? Se conservará en el historial.')) return;

  try {
    const res = await apiFetch(`${API_URL}/asistencia/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'No se pudo anular el registro.');
    await cargarAsistenciasBD();
    mostrarToast('Registro anulado');
  } catch (err) {
    console.error('Error al anular asistencia:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

async function restaurarAsistencia(id) {
  if (usuarioActual?.rol !== 'admin') return;

  try {
    const res = await apiFetch(`${API_URL}/asistencia/${id}/estado`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anulado: false })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'No se pudo restaurar el registro.');
    await cargarAsistenciasBD();
    mostrarToast('Registro restaurado');
  } catch (err) {
    console.error('Error al restaurar asistencia:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

function cargarSelectorAsistencia() {
  const select = document.getElementById('asist-emp');
  if (!select) return;
  select.innerHTML = '';
  empleados.filter(e => e.activo).forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.nombre;
    select.appendChild(opt);
  });
}

// --- SOLICITUDES ---

async function cargarSolicitudes() {
  if (!usuarioActual) return;

  try {
    const res = await apiFetch(`${API_URL}/solicitudes`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron cargar las solicitudes.');
    solicitudes = data;
    renderizarSolicitudes();
  } catch (err) {
    console.error('Error al cargar solicitudes:', err);
    const tbody = document.getElementById('tabla-solicitudes-body');
    if (tbody) {
      tbody.innerHTML = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = usuarioActual.rol === 'admin' ? 5 : 4;
      td.className = 'p-4 text-center text-rose-600';
      td.textContent = 'No se pudieron cargar las solicitudes. Verifica la conexión con el servidor.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }
}

async function crearSolicitud(event) {
  event.preventDefault();
  const tipo = document.getElementById('solicitud-tipo').value;
  const fechaInicio = document.getElementById('solicitud-inicio').value;
  const fechaFin = document.getElementById('solicitud-fin').value;
  const motivo = document.getElementById('solicitud-motivo').value.trim();
  const idSolicitud = solicitudEditandoId;

  try {
    const res = await apiFetch(idSolicitud
      ? `${API_URL}/solicitudes/${idSolicitud}`
      : `${API_URL}/solicitudes`, {
      method: idSolicitud ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo,
        fecha_inicio: fechaInicio,
        fecha_fin: fechaFin,
        motivo
      })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'No se pudo enviar la solicitud.');
      return;
    }
    cancelarEdicionSolicitud();
    mostrarToast(idSolicitud ? 'Solicitud actualizada' : 'Solicitud enviada correctamente');
    await cargarSolicitudes();
  } catch (err) {
    console.error('Error al crear solicitud:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

function cancelarEdicionSolicitud() {
  solicitudEditandoId = null;
  document.getElementById('form-solicitud')?.reset();
  const titulo = document.getElementById('titulo-form-solicitud');
  const boton = document.getElementById('btn-enviar-solicitud');
  const cancelar = document.getElementById('btn-cancelar-edicion-solicitud');
  if (titulo) titulo.textContent = 'Nueva solicitud';
  if (boton) boton.textContent = 'Enviar solicitud';
  if (cancelar) cancelar.classList.add('hidden');
}

function renderizarSolicitudes() {
  const tbody = document.getElementById('tabla-solicitudes-body');
  if (!tbody) return;

  const esAdmin = usuarioActual?.rol === 'admin';
  const formulario = document.getElementById('form-solicitud');
  const colPersona = document.getElementById('col-solicitud-persona');
  const colAcciones = document.getElementById('col-solicitud-acciones');
  if (formulario) formulario.classList.toggle('hidden', esAdmin);
  if (colPersona) colPersona.classList.toggle('hidden', !esAdmin);
  if (colAcciones) colAcciones.classList.remove('hidden');

  if (!Array.isArray(solicitudes) || solicitudes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${esAdmin ? 5 : 4}" class="p-4 text-center text-slate-400 italic">No hay solicitudes registradas.</td></tr>`;
    return;
  }

  tbody.innerHTML = solicitudes.map(solicitud => {
    const estadoClase = solicitud.estado === 'Aprobada'
      ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
      : solicitud.estado === 'Rechazada'
        ? 'bg-rose-100 text-rose-800 border-rose-300'
        : solicitud.estado === 'Cancelada'
          ? 'bg-slate-100 text-slate-600 border-slate-300'
          : 'bg-amber-100 text-amber-800 border-amber-300';
    const fechas = solicitud.fecha_inicio === solicitud.fecha_fin
      ? solicitud.fecha_inicio
      : `${solicitud.fecha_inicio} al ${solicitud.fecha_fin}`;
    const persona = esAdmin
      ? `<td class="p-3"><span class="font-bold">${solicitud.nombre || ''}</span></td>`
      : '';
    const acciones = esAdmin && solicitud.estado === 'Pendiente'
      ? `<td class="p-3 text-center space-x-2">
          <button onclick="responderSolicitud(${solicitud.id_solicitud}, 'Aprobada')" class="text-emerald-700 font-bold">Aprobar</button>
          <button onclick="responderSolicitud(${solicitud.id_solicitud}, 'Rechazada')" class="text-rose-700 font-bold">Rechazar</button>
          <button onclick="cancelarSolicitud(${solicitud.id_solicitud})" class="text-slate-600 font-bold">Cancelar</button>
        </td>`
      : esAdmin
        ? '<td class="p-3"></td>'
        : solicitud.estado === 'Pendiente'
          ? `<td class="p-3 text-center space-x-2">
              <button onclick="editarSolicitud(${solicitud.id_solicitud})" class="text-blue-700 font-bold">Editar</button>
              <button onclick="cancelarSolicitud(${solicitud.id_solicitud})" class="text-rose-700 font-bold">Cancelar</button>
            </td>`
            : '<td class="p-3"></td>';

    return `<tr>
      ${persona}
      <td class="p-3">${solicitud.tipo}</td>
      <td class="p-3">${fechas}</td>
      <td class="p-3"><span class="px-2 py-1 rounded border text-[11px] font-bold ${estadoClase}">${solicitud.estado}</span></td>
      ${acciones}
    </tr>`;
  }).join('');
}

async function responderSolicitud(id, estado) {
  if (usuarioActual?.rol !== 'admin') return;

  try {
    const res = await apiFetch(`${API_URL}/solicitudes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'No se pudo actualizar la solicitud.');
      return;
    }
    mostrarToast(`Solicitud ${estado.toLowerCase()}`);
    await cargarSolicitudes();
  } catch (err) {
    console.error('Error al responder solicitud:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

function editarSolicitud(id) {
  if (usuarioActual?.rol !== 'atendedor') return;
  const solicitud = solicitudes.find(item => item.id_solicitud === id);
  if (!solicitud || solicitud.estado !== 'Pendiente') return;

  solicitudEditandoId = Number(id);
  document.getElementById('solicitud-tipo').value = solicitud.tipo;
  document.getElementById('solicitud-inicio').value = solicitud.fecha_inicio;
  document.getElementById('solicitud-fin').value = solicitud.fecha_fin;
  document.getElementById('solicitud-motivo').value = solicitud.motivo || '';
  document.getElementById('titulo-form-solicitud').textContent = 'Editar solicitud';
  document.getElementById('btn-enviar-solicitud').textContent = 'Guardar cambios';
  document.getElementById('btn-cancelar-edicion-solicitud').classList.remove('hidden');
  document.getElementById('form-solicitud').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function cancelarSolicitud(id) {
  if (!usuarioActual) return;
  if (!confirm('¿Quieres cancelar esta solicitud? Se conservará en el historial.')) return;

  try {
    const res = await apiFetch(`${API_URL}/solicitudes/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'No se pudo cancelar la solicitud.');
    mostrarToast('Solicitud cancelada');
    await cargarSolicitudes();
  } catch (err) {
    console.error('Error al cancelar solicitud:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

function cambiarTab(tab) {
  ['turnos', 'empleados', 'administracion', 'asistencia', 'solicitudes'].forEach(t => {
    const sec = document.getElementById(`sec-${t}`);
    const btn = document.getElementById(`tab-${t}`);
    if (sec) sec.classList.add('hidden');
    if (btn) {
      btn.classList.remove('border-red-600', 'text-red-600');
      btn.classList.add('border-transparent', 'text-slate-500');
    }
  });

  const activeSec = document.getElementById(`sec-${tab}`);
  const activeBtn = document.getElementById(`tab-${tab}`);
  if (activeSec) activeSec.classList.remove('hidden');
  if (activeBtn) {
    activeBtn.classList.remove('border-transparent', 'text-slate-500');
    activeBtn.classList.add('border-red-600', 'text-red-600');
  }
}

function exportarHorarioPDF() {
  if (!usuarioActual) return;
  window.print();
}

async function compartirEnlace() {
  if (!usuarioActual) return;

  const enlace = `${window.location.origin}${window.location.pathname}#turnos`;
  try {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(enlace);
        mostrarToast('Enlace copiado. Quien lo abra deberá iniciar sesión.');
        return;
      } catch (err) {
        console.warn('El portapapeles del navegador no está disponible; se probará la alternativa.', err);
      }
    }

    const campo = document.createElement('textarea');
    campo.value = enlace;
    campo.setAttribute('readonly', '');
    campo.style.position = 'fixed';
    campo.style.opacity = '0';
    document.body.appendChild(campo);
    let copiado;
    try {
      campo.select();
      copiado = document.execCommand('copy');
    } finally {
      campo.remove();
    }
    if (!copiado) throw new Error('El navegador no permitió copiar el enlace.');
    mostrarToast('Enlace copiado. Quien lo abra deberá iniciar sesión.');
  } catch (err) {
    console.error('Error al copiar el enlace del horario:', err);
    alert(`No se pudo copiar el enlace. Puedes copiarlo manualmente:\n${enlace}`);
  }
}

function mostrarToast(msg) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toast-msg');
  if (toast && toastMsg) {
    toastMsg.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3000);
  }
}