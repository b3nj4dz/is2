// Estilos visuales por tipo de turno
const TURNOS_ESTILOS = {
  mañana: 'bg-amber-100 text-amber-900 border-amber-300 font-bold',
  tarde: 'bg-blue-100 text-blue-900 border-blue-300 font-bold',
  noche: 'bg-purple-100 text-purple-900 border-purple-300 font-bold',
  libre: 'bg-slate-100 text-slate-600 border-slate-300 font-bold'
};

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

let empleados = [];
let empleadoEditandoId = null;
let administradores = [];
let horarios = {};
let asistencias = [];
let solicitudes = [];
let usuarioActual = null;
let tokenCambioContrasena = null;
let colaGuardadoHorarios = Promise.resolve();

const API_URL = 'http://localhost:3000/api';

function limpiarSesionLocal() {
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

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && usuarioActual?.token) {
    limpiarSesionLocal();
    mostrarToast('La sesión venció. Inicia sesión nuevamente.');
  }
  return res;
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
  if (usuarioActual && usuarioActual.rol === 'admin') {
    cargarAdministradoresBD();
    cargarSolicitudesDesbloqueo();
    cargarAsistenciasBD();
  }
  cargarSolicitudes();
}

function aplicarPermisosPorRol() {
  const esAdmin = usuarioActual && usuarioActual.rol === 'admin';

  const tabEmpleados = document.getElementById('tab-empleados');
  const tabAsistencia = document.getElementById('tab-asistencia');
  const secAdministradores = document.getElementById('sec-administradores');
  const btnAuto = document.getElementById('cnt-btn-auto');
  const cuadranteSubtitulo = document.getElementById('cuadrante-subtitulo');

  if (!esAdmin) {
    if (tabEmpleados) tabEmpleados.classList.add('hidden');
    if (tabAsistencia) tabAsistencia.classList.add('hidden');
    if (secAdministradores) secAdministradores.classList.add('hidden');
    if (btnAuto) btnAuto.classList.add('hidden');
    if (cuadranteSubtitulo) cuadranteSubtitulo.textContent = 'Consulta la programación y turnos de la semana.';
    cambiarTab('turnos');
  } else {
    if (tabEmpleados) tabEmpleados.classList.remove('hidden');
    if (tabAsistencia) tabAsistencia.classList.remove('hidden');
    if (secAdministradores) secAdministradores.classList.remove('hidden');
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

async function cargarEmpleadosBD() {
  try {
    const res = await apiFetch(`${API_URL}/empleados`);
    const datosEmpleados = await res.json();
    if (!res.ok) throw new Error(datosEmpleados.error || 'No se pudieron cargar los atendedores.');
    empleados = datosEmpleados;

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
  } catch (err) {
    console.error('Error al cargar empleados:', err);
    mostrarToast(err.message || 'No se pudieron cargar los horarios.');
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
        <td colspan="5" class="p-4 text-center text-slate-400 italic">
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
      <td class="p-3 font-mono">${e.rut}</td>
      <td class="p-3 font-bold">${e.nombre}</td>
      <td class="p-3 text-slate-600 text-sm">${e.email || 'Sin correo'}</td>
      <td class="p-3">
        ${!activo
          ? '<span class="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-[11px] font-bold border border-slate-300">Archivado</span>'
          : e.licencia
          ? '<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded text-[11px] font-bold border border-amber-300">Licencia Médica</span>'
          : '<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded text-[11px] font-bold border border-emerald-300">Activo</span>'
        }
      </td>
      <td class="p-3 text-center space-x-2">
        <button onclick="editarEmpleado(${e.id})" class="text-xs bg-slate-100 hover:bg-slate-200 border px-2.5 py-1 rounded font-medium transition">
          Editar
        </button>
        ${activo ? `<button onclick="toggleLicencia(${e.id})" class="text-xs bg-slate-100 hover:bg-slate-200 border px-2.5 py-1 rounded font-medium transition">
          ${e.licencia ? 'Quitar Licencia' : 'Marcar Licencia'}
        </button>` : ''}
        <button onclick="cambiarEstadoEmpleado(${e.id}, ${!activo})" class="${activo ? 'text-rose-700' : 'text-emerald-700'} hover:underline p-1 rounded transition">
          ${activo ? 'Archivar' : 'Reactivar'}
        </button>
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
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="p-3 font-mono">${adm.rut}</td>
      <td class="p-3 font-bold">${adm.nombre}</td>
      <td class="p-3 text-slate-600">${adm.email}</td>
      <td class="p-3">${adm.departamento}</td>
      <td class="p-3">${activo ? 'Activo' : 'Archivado'}</td>
      <td class="p-3 text-center">
        <button onclick="editarAdministrador(${adm.id})" class="text-slate-700 hover:underline p-1 rounded transition text-xs font-semibold">
          Editar
        </button>
        <button onclick="cambiarEstadoAdministrador(${adm.id}, ${!activo})" class="${activo ? 'text-rose-700' : 'text-emerald-700'} hover:underline p-1 rounded transition text-xs font-semibold">
          ${activo ? 'Archivar' : 'Reactivar'}
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  lucide.createIcons();
}

async function agregarAdministradorModal() {
  if (usuarioActual.rol !== 'admin') return alert('Acceso denegado');

  const nom = prompt('Nombre Completo del Administrador:');
  if (!nom) return;
  const rut = prompt('RUT (ej: 12.345.678-9):');
  if (!rut) return;
  const email = prompt('Correo electrónico del Administrador:');
  if (!email) return;
  const departamento = prompt('Departamento del Administrador:');
  if (!departamento || !departamento.trim()) return;
  if (departamento.trim().length > 100) {
    return alert('El departamento no puede superar los 100 caracteres.');
  }
  const password = prompt('Defina una contraseña (8-128 caracteres, mayúscula, minúscula, número y símbolo):');
  if (!password) return;
  if (!esContrasenaSegura(password)) {
    return alert('La contraseña debe tener entre 8 y 128 caracteres e incluir mayúscula, minúscula, número y símbolo.');
  }

  try {
    const res = await apiFetch(`${API_URL}/administradores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rut, nombre: nom, email, departamento: departamento.trim(), password })
    });
    const data = await res.json();

    if (data.success) {
      mostrarToast('Administrador registrado con éxito');
      await cargarAdministradoresBD();
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    console.error('Error:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

async function editarAdministrador(id) {
  if (usuarioActual.rol !== 'admin') return alert('Acceso denegado');
  const admin = administradores.find(item => item.id === id);
  if (!admin) return;
  const nombre = prompt('Nombre completo:', admin.nombre);
  if (nombre === null) return;
  const rut = prompt('RUT:', admin.rut);
  if (rut === null) return;
  const email = prompt('Correo electrónico:', admin.email);
  if (email === null) return;
  const departamento = prompt('Departamento:', admin.departamento);
  if (departamento === null) return;

  try {
    const res = await apiFetch(`${API_URL}/administradores/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, rut, email, departamento })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'No se pudieron actualizar los datos.');
    await cargarAdministradoresBD();
    mostrarToast('Administrador actualizado');
  } catch (err) {
    console.error('Error al editar administrador:', err);
    alert('No se pudo conectar con el servidor.');
  }
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

function guardarHorariosBD() {
  const datosHorarios = empleados.filter(emp => emp.activo).map(emp => ({
    id_atendedor: emp.id,
    turnos: [...(horarios[emp.id] || [])]
  }));
  const guardar = colaGuardadoHorarios.then(async () => {
    const res = await apiFetch(`${API_URL}/horarios`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ horarios: datosHorarios })
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
      if (emp.licencia) {
        htmlCells += `<td class="p-2 text-center border-r border-slate-100 text-slate-400 italic text-[11px]">Licencia</td>`;
      } else {
        if (esAdmin) {
          htmlCells += `
            <td class="p-1.5 border-r border-slate-100">
              <select onchange="cambiarTurnoManual(${emp.id}, ${dIdx}, this.value)" 
                class="w-full text-xs p-1.5 rounded border transition cursor-pointer ${TURNOS_ESTILOS[tActual]}">
                <option value="mañana" ${tActual === 'mañana' ? 'selected' : ''}>Mañana</option>
                <option value="tarde" ${tActual === 'tarde' ? 'selected' : ''}>Tarde</option>
                <option value="noche" ${tActual === 'noche' ? 'selected' : ''}>Noche</option>
                <option value="libre" ${tActual === 'libre' ? 'selected' : ''}>Libre</option>
              </select>
            </td>
          `;
        } else {
          const formatoNombre = tActual.charAt(0).toUpperCase() + tActual.slice(1);
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
}

async function cambiarTurnoManual(empId, dIdx, nuevoTurno) {
  if (usuarioActual.rol !== 'admin') return;
  if (!horarios[empId] || dIdx < 0 || dIdx > 6) return;

  horarios[empId][dIdx] = nuevoTurno;
  renderizarCuadrante();
  try {
    await guardarHorariosBD();
    mostrarToast('Turno guardado correctamente');
  } catch (err) {
    alert(err.message || 'El turno cambió en pantalla, pero no se pudo guardar.');
  }
}

async function generarTurnosAuto() {
  if (usuarioActual.rol !== 'admin') return;

  const turnosLaborales = ['mañana', 'tarde', 'noche'];
  
  empleados.forEach(emp => {
    if (!emp.activo) return;
    if (!emp.licencia) {
      let turnosEmpleado = Array(7).fill(null);
      
      let diasLibresIndices = [];
      while (diasLibresIndices.length < 2) {
        let idx = Math.floor(Math.random() * 7);
        if (!diasLibresIndices.includes(idx)) {
          diasLibresIndices.push(idx);
        }
      }

      diasLibresIndices.forEach(idx => {
        turnosEmpleado[idx] = 'libre';
      });

      for (let i = 0; i < 7; i++) {
        if (turnosEmpleado[i] === 'libre') continue;

        let validos = [...turnosLaborales];
        if (i > 0 && turnosEmpleado[i - 1] === 'noche') {
          validos = validos.filter(t => t !== 'mañana');
        }

        turnosEmpleado[i] = validos[Math.floor(Math.random() * validos.length)];
      }

      horarios[emp.id] = turnosEmpleado;
    }
  });

  renderizarCuadrante();
  try {
    await guardarHorariosBD();
    mostrarToast('Turnos generados y guardados con distribución equilibrada de descansos');
  } catch (err) {
    alert(err.message || 'Se generaron los turnos, pero no se pudieron guardar.');
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

  try {
    const res = await apiFetch(`${API_URL}/solicitudes`, {
      method: 'POST',
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
    event.target.reset();
    mostrarToast('Solicitud enviada correctamente');
    await cargarSolicitudes();
  } catch (err) {
    console.error('Error al crear solicitud:', err);
    alert('No se pudo conectar con el servidor.');
  }
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

async function editarSolicitud(id) {
  if (usuarioActual?.rol !== 'atendedor') return;
  const solicitud = solicitudes.find(item => item.id_solicitud === id);
  if (!solicitud || solicitud.estado !== 'Pendiente') return;

  const tipo = prompt('Tipo (Dia libre o Licencia):', solicitud.tipo);
  if (tipo === null) return;
  const fechaInicio = prompt('Fecha de inicio (AAAA-MM-DD):', solicitud.fecha_inicio);
  if (fechaInicio === null) return;
  const fechaFin = prompt('Fecha de término (AAAA-MM-DD):', solicitud.fecha_fin);
  if (fechaFin === null) return;
  const motivo = prompt('Motivo:', solicitud.motivo || '');
  if (motivo === null) return;

  try {
    const res = await apiFetch(`${API_URL}/solicitudes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo,
        fecha_inicio: fechaInicio,
        fecha_fin: fechaFin,
        motivo
      })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'No se pudo editar la solicitud.');
    mostrarToast('Solicitud actualizada');
    await cargarSolicitudes();
  } catch (err) {
    console.error('Error al editar solicitud:', err);
    alert('No se pudo conectar con el servidor.');
  }
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
  ['turnos', 'empleados', 'asistencia', 'solicitudes'].forEach(t => {
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

function compartirEnlace() {
  mostrarToast('Enlace de horario copiado al portapapeles');
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