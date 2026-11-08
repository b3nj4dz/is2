// Estilos visuales por tipo de turno
const TURNOS_ESTILOS = {
  mañana: 'bg-amber-100 text-amber-900 border-amber-300 font-bold',
  tarde: 'bg-blue-100 text-blue-900 border-blue-300 font-bold',
  noche: 'bg-purple-100 text-purple-900 border-purple-300 font-bold',
  libre: 'bg-slate-100 text-slate-600 border-slate-300 font-bold'
};

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

let empleados = [];
let horarios = {};
let asistencias = [];
let usuarioActual = null;

const API_URL = 'http://localhost:3000/api';

window.onload = function () {
  lucide.createIcons();
  
  const sesionGuardada = localStorage.getItem('copec_sesion');
  if (sesionGuardada) {
    usuarioActual = JSON.parse(sesionGuardada);
    mostrarPanelPrincipal();
  }
};

// --- AUTENTICACIÓN Y LOGIN ---

async function iniciarSesion(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch(`${API_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();

    if (data.success) {
      usuarioActual = data.usuario;
      localStorage.setItem('copec_sesion', JSON.stringify(usuarioActual));
      mostrarToast(`Bienvenido/a ${usuarioActual.nombre}`);
      mostrarPanelPrincipal();
    } else {
      alert(data.error || 'Credenciales incorrectas');
    }
  } catch (err) {
    console.error('Error en login:', err);
    alert('Error de conexión con el servidor');
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
}

function aplicarPermisosPorRol() {
  const esAdmin = usuarioActual && usuarioActual.rol === 'admin';

  const tabEmpleados = document.getElementById('tab-empleados');
  const tabAsistencia = document.getElementById('tab-asistencia');
  const btnAuto = document.getElementById('cnt-btn-auto');
  const cuadranteSubtitulo = document.getElementById('cuadrante-subtitulo');

  if (!esAdmin) {
    // Si es ATENDEDOR: Ocultar pestañas de administración y botón automático
    if (tabEmpleados) tabEmpleados.classList.add('hidden');
    if (tabAsistencia) tabAsistencia.classList.add('hidden');
    if (btnAuto) btnAuto.classList.add('hidden');
    if (cuadranteSubtitulo) cuadranteSubtitulo.textContent = 'Consulta la programación y turnos de la semana.';
    cambiarTab('turnos');
  } else {
    // Si es ADMINISTRADOR: Mostrar todo el panel
    if (tabEmpleados) tabEmpleados.classList.remove('hidden');
    if (tabAsistencia) tabAsistencia.classList.remove('hidden');
    if (btnAuto) btnAuto.classList.remove('hidden');
    if (cuadranteSubtitulo) cuadranteSubtitulo.textContent = 'Selecciona el turno directamente en cada casilla para ajustar la asignación.';
  }
}

function cerrarSesion() {
  localStorage.removeItem('copec_sesion');
  usuarioActual = null;
  document.getElementById('sec-app').classList.add('hidden');
  document.getElementById('sec-login').classList.remove('hidden');
  mostrarToast('Sesión cerrada correctamente');
}

// --- GESTIÓN DE EMPLEADOS ---

async function cargarEmpleadosBD() {
  try {
    const res = await fetch(`${API_URL}/empleados`);
    empleados = await res.json();

    actualizarHorarios();
    renderizarEmpleados();
    renderizarCuadrante();
    cargarSelectorAsistencia();
  } catch (err) {
    console.error('Error al cargar empleados:', err);
  }
}

async function agregarEmpleadoModal() {
  if (usuarioActual.rol !== 'admin') {
    return alert('Acceso denegado: Solo administradores pueden agregar personal.');
  }

  const nom = prompt('Ingrese Nombre Completo del Atendedor:');
  if (!nom) return;
  const rut = prompt('Ingrese RUT (ej: 19.876.543-2):');
  if (!rut) return;

  try {
    const res = await fetch(`${API_URL}/empleados`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rut: rut, nombre: nom })
    });

    const data = await res.json();

    if (data.success) {
      mostrarToast(`Guardado. Correo: ${data.emailCreado}`);
      await cargarEmpleadosBD();
    } else {
      alert('Error en la base de datos: ' + data.error);
    }
  } catch (err) {
    console.error('Error de conexión:', err);
    alert('No se pudo conectar con el servidor.');
  }
}

function renderizarEmpleados() {
  const tbody = document.getElementById('tabla-empleados-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  empleados.forEach(e => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="p-3 font-mono">${e.rut}</td>
      <td class="p-3 font-bold">${e.nombre}</td>
      <td class="p-3">
        ${e.licencia 
          ? '<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded text-[11px] font-bold border border-amber-300">Licencia Médica</span>'
          : '<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded text-[11px] font-bold border border-emerald-300">Activo</span>'
        }
      </td>
      <td class="p-3 text-center space-x-2">
        <button onclick="toggleLicencia(${e.id})" class="text-xs bg-slate-100 hover:bg-slate-200 border px-2.5 py-1 rounded font-medium transition">
          ${e.licencia ? 'Quitar Licencia' : 'Marcar Licencia'}
        </button>
        <button onclick="eliminarEmpleado(${e.id})" class="text-rose-600 hover:text-rose-800 p-1 rounded transition">
          <i data-lucide="trash-2" class="w-4 h-4 inline"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  lucide.createIcons();
}

async function toggleLicencia(id) {
  if (usuarioActual.rol !== 'admin') {
    return alert('Acceso denegado: Solo administradores pueden modificar licencias.');
  }

  const emp = empleados.find(e => e.id === id);
  if (!emp) return;

  const nuevoEstado = !emp.licencia;

  try {
    const res = await fetch(`${API_URL}/empleados/${id}/licencia`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licencia: nuevoEstado })
    });

    const data = await res.json();

    if (data.success) {
      emp.licencia = nuevoEstado;
      
      if (nuevoEstado) {
        horarios[id] = Array(7).fill('libre');
      } else {
        const opciones = ['mañana', 'tarde', 'noche', 'libre'];
        horarios[id] = DIAS.map((_, dIdx) => opciones[(id + dIdx) % 4]);
      }

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

function eliminarEmpleado(id) {
  if (usuarioActual.rol !== 'admin') {
    return alert('Acceso denegado: Solo administradores pueden eliminar personal.');
  }

  empleados = empleados.filter(e => e.id !== id);
  delete horarios[id];
  renderizarEmpleados();
  renderizarCuadrante();
  cargarSelectorAsistencia();
  mostrarToast('Atendedor eliminado del panel');
}

// --- GESTIÓN DE TURNOS Y CUADRANTE ---

function actualizarHorarios() {
  const opciones = ['mañana', 'tarde', 'noche', 'libre'];
  empleados.forEach((emp, i) => {
    if (emp.licencia) {
      horarios[emp.id] = Array(7).fill('libre');
    } else if (!horarios[emp.id]) {
      horarios[emp.id] = DIAS.map((_, dIdx) => opciones[(i + dIdx) % 4]);
    }
  });
}

function renderizarCuadrante() {
  const tbody = document.getElementById('tabla-turnos-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const esAdmin = usuarioActual && usuarioActual.rol === 'admin';

  empleados.forEach(emp => {
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
          // Si es ADMIN: Puede editar el turno
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
          // Si es ATENDEDOR: Solo ver el turno (Sin lista desplegable)
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

function cambiarTurnoManual(empId, dIdx, nuevoTurno) {
  if (usuarioActual.rol !== 'admin') return;

  if (!horarios[empId]) horarios[empId] = Array(7).fill('libre');
  horarios[empId][dIdx] = nuevoTurno;
  renderizarCuadrante();
  mostrarToast('Turno modificado correctamente');
}

function generarTurnosAuto() {
  if (usuarioActual.rol !== 'admin') return;

  const turnosPosibles = ['mañana', 'tarde', 'noche', 'libre'];
  empleados.forEach(emp => {
    if (emp.licencia) {
      horarios[emp.id] = Array(7).fill('libre');
    } else {
      horarios[emp.id] = DIAS.map((_, dIdx) => {
        if (dIdx >= 5 && Math.random() > 0.5) return 'libre';
        return turnosPosibles[Math.floor(Math.random() * 3)];
      });
    }
  });
  renderizarCuadrante();
  mostrarToast('Turnos semanales distribuidos automáticamente');
}

// --- GESTIÓN DE ASISTENCIA ---

function guardarAsistencia(e) {
  e.preventDefault();
  if (usuarioActual.rol !== 'admin') return;

  const empId = Number(document.getElementById('asist-emp').value);
  const empObj = empleados.find(x => x.id === empId);
  const fecha = document.getElementById('asist-fecha').value;
  const foja = document.getElementById('asist-foja').value;
  const ord = Number(document.getElementById('asist-ord').value);
  const ext = Number(document.getElementById('asist-ext').value);

  const nuevoRegistro = {
    id: Date.now(),
    empId: empId,
    nombre: empObj ? empObj.nombre : 'Atendedor',
    fecha: fecha,
    ordinarias: ord,
    extras: ext,
    foja: foja
  };

  asistencias.unshift(nuevoRegistro);
  renderizarAsistencias();
  mostrarToast('Registro de asistencia guardado');
  document.getElementById('asist-foja').value = '';
}

function renderizarAsistencias() {
  const tbody = document.getElementById('tabla-asistencia-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  asistencias.forEach(a => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50';
    tr.innerHTML = `
      <td class="p-3 font-medium text-slate-600">${a.fecha}</td>
      <td class="p-3 font-bold">${a.nombre}</td>
      <td class="p-3">${a.ordinarias} hrs</td>
      <td class="p-3 font-bold text-emerald-600">+${a.extras} hrs</td>
      <td class="p-3 text-slate-400 font-mono">Foja #${a.foja}</td>
    `;
    tbody.appendChild(tr);
  });
}

function cargarSelectorAsistencia() {
  const select = document.getElementById('asist-emp');
  if (!select) return;
  select.innerHTML = '';
  empleados.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.nombre;
    select.appendChild(opt);
  });
}

// --- NAVEGACIÓN Y TOASTS ---

function cambiarTab(tab) {
  ['turnos', 'empleados', 'asistencia'].forEach(t => {
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