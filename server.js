const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const {
  esHashContrasena,
  esContrasenaSegura,
  hashContrasena,
  verificarContrasena
} = require('./password-utils');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Conexión directa a MariaDB en XAMPP
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'gestion_turnos_copec'
});

function consulta(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

function fechaISOValida(fecha) {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const parsed = new Date(`${fecha}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === fecha;
}

async function migrarContrasenasExistentes() {
  const usuarios = await consulta('SELECT id_usuario, hash_contrasena FROM usuario');
  for (const usuario of usuarios) {
    if (esHashContrasena(usuario.hash_contrasena)) continue;
    const debeCambiar = esContrasenaSegura(usuario.hash_contrasena) ? 0 : 1;
    const hash = await hashContrasena(usuario.hash_contrasena);
    await consulta(
      'UPDATE usuario SET hash_contrasena = ?, debe_cambiar_contrasena = ? WHERE id_usuario = ?',
      [hash, debeCambiar, usuario.id_usuario]
    );
  }
}

let solicitudSchemaReady = false;
let autenticacionSchemaReady = false;
let horariosSchemaReady = false;
const tokensCambioContrasena = new Map();
const sesiones = new Map();
const DURACION_SESION_MS = 8 * 60 * 60 * 1000;

function crearSesion(idUsuario) {
  const ahora = Date.now();
  for (const [token, sesion] of sesiones) {
    if (sesion.expira <= ahora) sesiones.delete(token);
  }

  const token = crypto.randomBytes(32).toString('hex');
  sesiones.set(token, { idUsuario, expira: ahora + DURACION_SESION_MS });
  return token;
}

function autenticar(req, res, next) {
  const authorization = req.get('authorization') || '';
  const [scheme, token] = authorization.split(' ');
  const sesion = token && sesiones.get(token);
  if (scheme !== 'Bearer' || !sesion || sesion.expira <= Date.now()) {
    if (token) sesiones.delete(token);
    return res.status(401).json({ error: 'Sesión inválida o vencida. Inicia sesión nuevamente.' });
  }

  db.query(`
    SELECT u.id_usuario, adm.id_administrador, at.id_atendedor
    FROM usuario u
    LEFT JOIN administrador adm ON adm.id_usuario = u.id_usuario AND adm.activo = 1
    LEFT JOIN atendedor at ON at.id_usuario = u.id_usuario AND at.activo = 1
    WHERE u.id_usuario = ? AND u.bloqueado = 0
  `, [sesion.idUsuario], (err, users) => {
    if (err) return res.status(500).json({ error: 'No se pudo validar la sesión.' });
    if (users.length === 0) {
      sesiones.delete(token);
      return res.status(401).json({ error: 'La cuenta ya no puede usar esta sesión.' });
    }

    const user = users[0];
    if (!user.id_administrador && !user.id_atendedor) {
      sesiones.delete(token);
      return res.status(401).json({ error: 'La cuenta ya no tiene un rol activo. Inicia sesión nuevamente.' });
    }

    req.auth = {
      token,
      idUsuario: user.id_usuario,
      idAdministrador: user.id_administrador,
      idAtendedor: user.id_atendedor
    };
    next();
  });
}

function soloAdministrador(req, res, next) {
  if (!req.auth?.idAdministrador) {
    return res.status(403).json({ error: 'Acceso reservado a administradores.' });
  }
  next();
}

function soloAtendedor(req, res, next) {
  if (!req.auth?.idAtendedor) {
    return res.status(403).json({ error: 'Acceso reservado a atendedores.' });
  }
  next();
}

db.connect(err => {
  if (err) {
    console.error('Error al conectar a MariaDB:', err);
  } else {
    console.log('Conectado exitosamente a la base de datos gestion_turnos_copec en XAMPP');
    const columnas = [
      ['solicituddialibre', 'motivo', 'TEXT NULL'],
      ['usuario', 'intentos_fallidos', 'INT NOT NULL DEFAULT 0'],
      ['usuario', 'bloqueado', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['usuario', 'debe_cambiar_contrasena', 'TINYINT(1) NOT NULL DEFAULT 1'],
      ['atendedor', 'activo', 'TINYINT(1) NOT NULL DEFAULT 1'],
      ['administrador', 'activo', 'TINYINT(1) NOT NULL DEFAULT 1'],
      ['registroasistencia', 'anulado', 'TINYINT(1) NOT NULL DEFAULT 0']
    ];

    const asegurarColumna = indice => {
      if (indice === columnas.length) {
        db.query(`
          CREATE TABLE IF NOT EXISTS solicituddesbloqueo (
            id_solicitud INT AUTO_INCREMENT PRIMARY KEY,
            id_usuario INT NOT NULL,
            estado_solicitud VARCHAR(50) NOT NULL DEFAULT 'Pendiente',
            fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            fecha_respuesta TIMESTAMP NULL DEFAULT NULL,
            id_administrador INT NULL,
            KEY id_usuario (id_usuario),
            KEY id_administrador (id_administrador),
            CONSTRAINT solicituddesbloqueo_ibfk_1
              FOREIGN KEY (id_usuario) REFERENCES usuario (id_usuario) ON DELETE CASCADE,
            CONSTRAINT solicituddesbloqueo_ibfk_2
              FOREIGN KEY (id_administrador) REFERENCES administrador (id_administrador) ON DELETE SET NULL
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `, errTable => {
          if (errTable) {
            console.error('Error al preparar la tabla de solicitudes de desbloqueo:', errTable);
            return;
          }
          db.query(`
            CREATE TABLE IF NOT EXISTS asignacionsemanal (
              id_atendedor INT NOT NULL,
              dia_semana TINYINT UNSIGNED NOT NULL,
              turno ENUM('mañana', 'tarde', 'noche', 'libre') NOT NULL,
              PRIMARY KEY (id_atendedor, dia_semana),
              CONSTRAINT asignacionsemanal_ibfk_1
                FOREIGN KEY (id_atendedor) REFERENCES atendedor (id_atendedor) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
          `, errScheduleTable => {
            if (errScheduleTable) {
              console.error('Error al preparar la tabla de horarios semanales:', errScheduleTable);
              return;
            }
            solicitudSchemaReady = true;
            horariosSchemaReady = true;
            migrarContrasenasExistentes()
              .then(() => {
                autenticacionSchemaReady = true;
                console.log('Contraseñas existentes protegidas con scrypt');
              })
              .catch(errMigration => {
                console.error('Error al proteger las contraseñas existentes:', errMigration);
              });
          });
        });
        return;
      }

      const [table, column, definition] = columnas[indice];
      db.query(`
        SELECT COUNT(*) AS existe
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
      `, [table, column], (errColumn, results) => {
        if (errColumn) {
          console.error(`Error al verificar ${table}.${column}:`, errColumn);
          return;
        }

        if (results[0].existe) {
          asegurarColumna(indice + 1);
          return;
        }

        db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, errAlter => {
          if (errAlter) {
            console.error(`Error al agregar ${table}.${column}:`, errAlter);
            return;
          }
          asegurarColumna(indice + 1);
        });
      });
    };

    asegurarColumna(0);
  }
});

// 0. AUTENTICACIÓN / LOGIN
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  if (!email || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Ingresa correo y contraseña' });
  }
  if (!autenticacionSchemaReady) {
    return res.status(503).json({ error: 'La autenticación aún no está lista. Intenta nuevamente.' });
  }

  const sql = `
    SELECT u.id_usuario, u.rut, u.nombre, u.email, u.hash_contrasena,
           u.intentos_fallidos, u.bloqueado, u.debe_cambiar_contrasena,
           adm.id_administrador, at.id_atendedor
    FROM usuario u
    LEFT JOIN administrador adm ON u.id_usuario = adm.id_usuario AND adm.activo = 1
    LEFT JOIN atendedor at ON u.id_usuario = at.id_usuario AND at.activo = 1
    WHERE u.email = ?
  `;

  db.query(sql, [email], async (err, results) => {
    if (err) return res.status(500).json({ error: err.message });

    if (results.length === 0) {
      return res.status(401).json({ success: false, error: 'Correo o contraseña incorrectos' });
    }

    const user = results[0];
    if (user.bloqueado) {
      return res.status(423).json({
        success: false,
        bloqueado: true,
        error: 'Cuenta bloqueada tras 3 intentos fallidos. Solicita el desbloqueo a un administrador.'
      });
    }

    let passwordMatches;
    try {
      passwordMatches = await verificarContrasena(password, user.hash_contrasena);
    } catch (errVerify) {
      return res.status(500).json({ error: 'No se pudo verificar la contraseña.' });
    }

    if (!passwordMatches) {
      db.query(`
        UPDATE usuario
        SET bloqueado = IF(intentos_fallidos + 1 >= 3, 1, 0),
            intentos_fallidos = intentos_fallidos + 1
        WHERE id_usuario = ? AND bloqueado = 0
      `, [user.id_usuario], (errUpdate) => {
        if (errUpdate) return res.status(500).json({ error: errUpdate.message });

        db.query(
          'SELECT intentos_fallidos, bloqueado FROM usuario WHERE id_usuario = ?',
          [user.id_usuario],
          (errAttempts, rows) => {
            if (errAttempts) return res.status(500).json({ error: errAttempts.message });
            const estado = rows[0];
            if (estado.bloqueado) {
              return res.status(423).json({
                success: false,
                bloqueado: true,
                error: 'Cuenta bloqueada tras 3 intentos fallidos. Solicita el desbloqueo a un administrador.'
              });
            }
            const restantes = Math.max(0, 3 - estado.intentos_fallidos);
            res.status(401).json({
              success: false,
              intentos_restantes: restantes,
              error: `Correo o contraseña incorrectos. Te quedan ${restantes} intento(s).`
            });
          }
        );
      });
      return;
    }

    if (!user.id_administrador && !user.id_atendedor) {
      return res.status(403).json({ success: false, error: 'La cuenta no tiene un rol habilitado.' });
    }

    let passwordHash = user.hash_contrasena;
    if (!esHashContrasena(passwordHash)) {
      try {
        passwordHash = await hashContrasena(password);
      } catch (errHash) {
        return res.status(500).json({ error: 'No se pudo proteger la contraseña.' });
      }
    }

    db.query(
      'UPDATE usuario SET hash_contrasena = ?, intentos_fallidos = 0 WHERE id_usuario = ?',
      [passwordHash, user.id_usuario],
      errReset => {
        if (errReset) return res.status(500).json({ error: errReset.message });
        if (user.debe_cambiar_contrasena) {
          for (const [token, datos] of tokensCambioContrasena) {
            if (datos.expira < Date.now()) tokensCambioContrasena.delete(token);
          }
          const changeToken = crypto.randomBytes(32).toString('hex');
          tokensCambioContrasena.set(changeToken, {
            idUsuario: user.id_usuario,
            expira: Date.now() + 10 * 60 * 1000
          });
          return res.json({
            success: false,
            requiereCambioContrasena: true,
            tokenCambio: changeToken,
            error: 'Debes crear una contraseña segura antes de continuar.'
          });
        }

        const esAdmin = Boolean(user.id_administrador);
        res.json({
          success: true,
          usuario: {
            id: user.id_usuario,
            rut: user.rut,
            nombre: user.nombre || user.email,
            email: user.email,
            rol: esAdmin ? 'admin' : 'atendedor',
            token: crearSesion(user.id_usuario)
          }
        });
        }
    );
  });
});

app.post('/api/logout', autenticar, (req, res) => {
  sesiones.delete(req.auth.token);
  res.json({ success: true });
});

app.post('/api/cambiar-contrasena', async (req, res) => {
  const { tokenCambio, password } = req.body;
  if (typeof tokenCambio !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'La solicitud de cambio de contraseña es inválida.' });
  }
  if (!esContrasenaSegura(password)) {
    return res.status(400).json({
      error: 'La contraseña debe tener entre 8 y 128 caracteres e incluir mayúscula, minúscula, número y símbolo.'
    });
  }

  const token = tokensCambioContrasena.get(tokenCambio);
  if (!token || token.expira < Date.now()) {
    tokensCambioContrasena.delete(tokenCambio);
    return res.status(401).json({ error: 'La sesión de cambio venció. Inicia sesión nuevamente.' });
  }

  let passwordHash;
  try {
    passwordHash = await hashContrasena(password);
  } catch (errHash) {
    console.error('Error al proteger la nueva contraseña:', errHash);
    return res.status(500).json({ error: 'No se pudo proteger la nueva contraseña.' });
  }

  db.query(`
    UPDATE usuario
    SET hash_contrasena = ?, debe_cambiar_contrasena = 0, intentos_fallidos = 0
    WHERE id_usuario = ? AND debe_cambiar_contrasena = 1
  `, [passwordHash, token.idUsuario], (errUpdate, result) => {
    if (errUpdate) return res.status(500).json({ error: errUpdate.message });
    if (result.affectedRows === 0) {
      tokensCambioContrasena.delete(tokenCambio);
      return res.status(409).json({ error: 'La cuenta ya no requiere cambio de contraseña.' });
    }

    tokensCambioContrasena.delete(tokenCambio);
    res.json({ success: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  });
});

app.post('/api/solicitudes-desbloqueo', (req, res) => {
  if (!autenticacionSchemaReady) {
    return res.status(503).json({ error: 'La autenticación aún no está lista. Intenta nuevamente.' });
  }
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  if (!email) return res.status(400).json({ error: 'Ingresa el correo de la cuenta bloqueada.' });

  const respuesta = {
    success: true,
    message: 'Si la cuenta está bloqueada, la solicitud fue enviada al administrador.'
  };
  db.query(
    'SELECT id_usuario FROM usuario WHERE email = ? AND bloqueado = 1',
    [email],
    (err, users) => {
      if (err) return res.status(500).json({ error: err.message });
      if (users.length === 0) return res.json(respuesta);

      const idUsuario = users[0].id_usuario;
      db.query(`
        SELECT id_solicitud
        FROM solicituddesbloqueo
        WHERE id_usuario = ? AND estado_solicitud = 'Pendiente'
        LIMIT 1
      `, [idUsuario], (errPending, pending) => {
        if (errPending) return res.status(500).json({ error: errPending.message });
        if (pending.length > 0) return res.json(respuesta);

        db.query(
          'INSERT INTO solicituddesbloqueo (id_usuario) VALUES (?)',
          [idUsuario],
          errInsert => {
            if (errInsert) return res.status(500).json({ error: errInsert.message });
            res.json(respuesta);
          }
        );
      });
    }
  );
});

app.get('/api/solicitudes-desbloqueo', autenticar, soloAdministrador, (req, res) => {
  if (!autenticacionSchemaReady) {
    return res.status(503).json({ error: 'La autenticación aún no está lista. Intenta nuevamente.' });
  }

  db.query(`
    SELECT s.id_solicitud, s.estado_solicitud AS estado,
           DATE_FORMAT(s.fecha_creacion, '%Y-%m-%d %H:%i') AS fecha_creacion,
           u.nombre, u.email
    FROM solicituddesbloqueo s
    INNER JOIN usuario u ON u.id_usuario = s.id_usuario
    ORDER BY s.fecha_creacion DESC
  `, (err, requests) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(requests);
  });
});

app.put('/api/solicitudes-desbloqueo/:id', autenticar, soloAdministrador, (req, res) => {
  if (!autenticacionSchemaReady) {
    return res.status(503).json({ error: 'La autenticación aún no está lista. Intenta nuevamente.' });
  }
  const { estado } = req.body;
  if (!['Aprobada', 'Rechazada'].includes(estado)) {
    return res.status(400).json({ error: 'Estado de solicitud inválido.' });
  }

  db.query(`
        UPDATE solicituddesbloqueo s
        INNER JOIN usuario u ON u.id_usuario = s.id_usuario
        SET s.estado_solicitud = ?,
            s.id_administrador = ?,
            s.fecha_respuesta = CURRENT_TIMESTAMP,
            u.bloqueado = IF(? = 'Aprobada', 0, u.bloqueado),
            u.intentos_fallidos = IF(? = 'Aprobada', 0, u.intentos_fallidos)
        WHERE s.id_solicitud = ? AND s.estado_solicitud = 'Pendiente'
  `, [estado, req.auth.idAdministrador, estado, estado, req.params.id], (errUpdate, result) => {
    if (errUpdate) return res.status(500).json({ error: errUpdate.message });
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Solicitud pendiente no encontrada.' });
    }
    res.json({ success: true });
  });
});

app.get('/api/asistencia', autenticar, soloAdministrador, (req, res) => {
  db.query(`
    SELECT r.id_registro AS id,
           r.id_atendedor,
           DATE_FORMAT(r.fecha, '%Y-%m-%d') AS fecha,
           r.horas_normales AS ordinarias,
           r.horas_extras AS extras,
           r.origen_registro AS origen,
           r.anulado,
           u.nombre
    FROM registroasistencia r
    INNER JOIN atendedor a ON a.id_atendedor = r.id_atendedor
    INNER JOIN usuario u ON u.id_usuario = a.id_usuario
    ORDER BY r.fecha DESC, r.id_registro DESC
  `, (err, registros) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(registros);
  });
});

app.post('/api/asistencia', autenticar, soloAdministrador, (req, res) => {
  const { id_atendedor, fecha, horas_normales, horas_extras, origen_registro } = req.body;
  const horasNormales = Number(horas_normales);
  const horasExtras = Number(horas_extras);
  const origen = typeof origen_registro === 'string' ? origen_registro.trim() : '';

  if (!Number.isInteger(Number(id_atendedor)) || Number(id_atendedor) <= 0 ||
      !fechaISOValida(fecha) ||
      horas_normales === undefined || horas_normales === null || horas_normales === '' ||
      horas_extras === undefined || horas_extras === null || horas_extras === '' ||
      !Number.isFinite(horasNormales) || horasNormales < 0 ||
      !Number.isFinite(horasExtras) || horasExtras < 0 ||
      !origen || origen.length > 50) {
    return res.status(400).json({ error: 'Completa los datos de asistencia con valores válidos.' });
  }

  db.query(
    'SELECT id_atendedor FROM atendedor WHERE id_atendedor = ? AND activo = 1',
    [id_atendedor],
    (errAtendedor, atendedores) => {
      if (errAtendedor) return res.status(500).json({ error: errAtendedor.message });
      if (atendedores.length === 0) {
        return res.status(404).json({ error: 'No se encontró el atendedor seleccionado.' });
      }

      const sql = `
        INSERT INTO registroasistencia
          (fecha, horas_normales, horas_extras, origen_registro, id_atendedor, id_administrador)
        VALUES (?, ?, ?, ?, ?, ?)
      `;
      db.query(sql, [
        fecha,
        horasNormales,
        horasExtras,
        origen,
        id_atendedor,
        req.auth.idAdministrador
      ], (errInsert, result) => {
        if (errInsert) return res.status(500).json({ error: errInsert.message });
        res.json({ success: true, id: result.insertId });
      });
    }
  );
});

app.put('/api/asistencia/:id', autenticar, soloAdministrador, (req, res) => {
  const { fecha, horas_normales, horas_extras, origen_registro } = req.body;
  const horasNormales = Number(horas_normales);
  const horasExtras = Number(horas_extras);
  const origen = typeof origen_registro === 'string' ? origen_registro.trim() : '';

  if (!fechaISOValida(fecha) ||
      horas_normales === undefined || horas_normales === null || horas_normales === '' ||
      horas_extras === undefined || horas_extras === null || horas_extras === '' ||
      !Number.isFinite(horasNormales) || horasNormales < 0 ||
      !Number.isFinite(horasExtras) || horasExtras < 0 ||
      !origen || origen.length > 50) {
    return res.status(400).json({ error: 'Completa los datos de asistencia con valores válidos.' });
  }

  db.query('SELECT anulado FROM registroasistencia WHERE id_registro = ?', [req.params.id], (errFind, rows) => {
    if (errFind) return res.status(500).json({ error: 'No se pudo validar el registro de asistencia.' });
    if (rows.length === 0) return res.status(404).json({ error: 'Registro de asistencia no encontrado.' });
    if (rows[0].anulado) return res.status(409).json({ error: 'No se puede editar un registro anulado.' });
    db.query(`
      UPDATE registroasistencia
      SET fecha = ?, horas_normales = ?, horas_extras = ?, origen_registro = ?
      WHERE id_registro = ? AND anulado = 0
    `, [fecha, horasNormales, horasExtras, origen, req.params.id], errUpdate => {
      if (errUpdate) return res.status(500).json({ error: 'No se pudo actualizar la asistencia.' });
      res.json({ success: true });
    });
  });
});

app.delete('/api/asistencia/:id', autenticar, soloAdministrador, (req, res) => {
  db.query(`
    UPDATE registroasistencia
    SET anulado = 1
    WHERE id_registro = ? AND anulado = 0
  `, [req.params.id], (errUpdate, result) => {
    if (errUpdate) return res.status(500).json({ error: 'No se pudo anular el registro de asistencia.' });
    if (result.affectedRows === 0) {
      return db.query('SELECT anulado FROM registroasistencia WHERE id_registro = ?', [req.params.id], (errFind, rows) => {
        if (errFind) return res.status(500).json({ error: 'No se pudo validar el registro de asistencia.' });
        if (rows.length === 0) return res.status(404).json({ error: 'Registro de asistencia no encontrado.' });
        res.status(409).json({ error: 'El registro ya está anulado.' });
      });
    }
    res.json({ success: true, message: 'Registro anulado; se conservó el historial.' });
  });
});

app.put('/api/asistencia/:id/estado', autenticar, soloAdministrador, (req, res) => {
  if (req.body.anulado !== false) {
    return res.status(400).json({ error: 'El estado del registro no es válido.' });
  }
  db.query('UPDATE registroasistencia SET anulado = 0 WHERE id_registro = ?', [req.params.id], (errUpdate, result) => {
    if (errUpdate) return res.status(500).json({ error: 'No se pudo restaurar el registro.' });
    if (result.affectedRows === 0) {
      return db.query('SELECT id_registro FROM registroasistencia WHERE id_registro = ?', [req.params.id], (errFind, rows) => {
        if (errFind) return res.status(500).json({ error: 'No se pudo validar el registro.' });
        if (rows.length === 0) return res.status(404).json({ error: 'Registro de asistencia no encontrado.' });
        res.json({ success: true });
      });
    }
    res.json({ success: true });
  });
});

app.get('/api/horarios', autenticar, (req, res) => {
  if (!horariosSchemaReady) {
    return res.status(503).json({ error: 'La base de datos de horarios aún no está lista.' });
  }

  const filtroAtendedor = req.auth.idAtendedor ? 'WHERE a.id_atendedor = ?' : '';
  const params = req.auth.idAtendedor ? [req.auth.idAtendedor] : [];
  db.query(`
    SELECT h.id_atendedor, h.dia_semana, h.turno
    FROM asignacionsemanal h
    INNER JOIN atendedor a ON a.id_atendedor = h.id_atendedor
    ${filtroAtendedor}
    ORDER BY h.id_atendedor, h.dia_semana
  `, params, (err, asignaciones) => {
    if (err) return res.status(500).json({ error: 'No se pudieron cargar los horarios.' });
    res.json(asignaciones);
  });
});

app.put('/api/horarios', autenticar, soloAdministrador, (req, res) => {
  if (!horariosSchemaReady) {
    return res.status(503).json({ error: 'La base de datos de horarios aún no está lista.' });
  }

  const { horarios } = req.body;
  const turnosValidos = new Set(['mañana', 'tarde', 'noche', 'libre']);
  if (!Array.isArray(horarios) || horarios.length > 500) {
    return res.status(400).json({ error: 'La lista de horarios no es válida.' });
  }

  const idsAtendedores = new Set();
  for (const horario of horarios) {
    if (!horario || typeof horario !== 'object' || Array.isArray(horario)) {
      return res.status(400).json({ error: 'La lista de horarios no es válida.' });
    }
    const idAtendedor = Number(horario.id_atendedor);
    if (!Number.isInteger(idAtendedor) || idAtendedor <= 0 ||
        idsAtendedores.has(idAtendedor) ||
        !Array.isArray(horario.turnos) || horario.turnos.length !== 7 ||
        !horario.turnos.every(turno => turnosValidos.has(turno))) {
      return res.status(400).json({ error: 'Cada atendedor debe tener siete turnos válidos.' });
    }
    idsAtendedores.add(idAtendedor);
  }

  if (horarios.length === 0) return res.json({ success: true });

  const ids = [...idsAtendedores];
  db.query('SELECT id_atendedor FROM atendedor WHERE activo = 1 AND id_atendedor IN (?)', [ids], (errEmployees, rows) => {
    if (errEmployees) return res.status(500).json({ error: 'No se pudieron validar los atendedores.' });
    if (rows.length !== ids.length) {
      return res.status(400).json({ error: 'Uno o más atendedores ya no existen.' });
    }

    const valores = [];
    horarios.forEach(horario => {
      horario.turnos.forEach((turno, dia_semana) => {
        valores.push([Number(horario.id_atendedor), dia_semana, turno]);
      });
    });

    db.query(`
      INSERT INTO asignacionsemanal (id_atendedor, dia_semana, turno)
      VALUES ?
      ON DUPLICATE KEY UPDATE turno = VALUES(turno)
    `, [valores], (errSave, result) => {
      if (errSave) return res.status(500).json({ error: 'No se pudieron guardar los horarios.' });
      res.json({ success: true, asignaciones: result.affectedRows });
    });
  });
});

// 1. OBTENER EMPLEADOS (GET)
app.get('/api/empleados', autenticar, (req, res) => {
  const filtroAtendedor = req.auth.idAtendedor ? 'WHERE u.id_usuario = ?' : '';
  const sql = `SELECT a.id_atendedor AS id, u.id_usuario, u.rut, u.nombre AS nombre, u.email,
                      a.posee_licencia_medica AS licencia, a.activo
               FROM atendedor a
               INNER JOIN usuario u ON a.id_usuario = u.id_usuario
               ${filtroAtendedor}
               ORDER BY a.id_atendedor ASC`;
  db.query(sql, req.auth.idAtendedor ? [req.auth.idUsuario] : [], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    const empleadosFormateados = results.map(row => ({
      ...row,
      licencia: Boolean(row.licencia)
    }));
    res.json(empleadosFormateados);
  });
});

// 2. GUARDAR NUEVO ATENDEDOR CON CORREO PERSONAL (POST)
app.post('/api/empleados', autenticar, soloAdministrador, (req, res) => {
  const { rut, nombre, email, password } = req.body;
  if (!rut || !nombre || !email || !password) {
    return res.status(400).json({ error: 'Completa todos los datos obligatorios.' });
  }
  if (!esContrasenaSegura(password)) {
    return res.status(400).json({
      error: 'La contraseña debe tener entre 8 y 128 caracteres e incluir mayúscula, minúscula, número y símbolo.'
    });
  }

  hashContrasena(password).then(passwordHash => {
    const sqlUser = `INSERT INTO usuario (rut, hash_contrasena, email, nombre, debe_cambiar_contrasena) VALUES (?, ?, ?, ?, 0)`;

    db.query(sqlUser, [rut, passwordHash, email, nombre], (err, resultUser) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ error: 'El correo electrónico o RUT ya se encuentran registrados.' });
        }
        return res.status(500).json({ error: 'Error al insertar usuario: ' + err.message });
      }

      insertarAtendedor(resultUser.insertId, res);
    });
  }).catch(err => {
    console.error('Error al proteger la contraseña del atendedor:', err);
    res.status(500).json({ error: 'No se pudo proteger la contraseña del atendedor.' });
  });
});

app.put('/api/empleados/:id', autenticar, soloAdministrador, (req, res) => {
  const rut = typeof req.body.rut === 'string' ? req.body.rut.trim() : '';
  const nombre = typeof req.body.nombre === 'string' ? req.body.nombre.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  if (!rut || !nombre || !email || rut.length > 15 || nombre.length > 20 || email.length > 100) {
    return res.status(400).json({ error: 'Ingresa RUT, nombre y correo dentro de los límites permitidos.' });
  }

  db.query('SELECT id_usuario FROM atendedor WHERE id_atendedor = ?', [req.params.id], (errFind, rows) => {
    if (errFind) return res.status(500).json({ error: 'No se pudo validar el atendedor.' });
    if (rows.length === 0) return res.status(404).json({ error: 'Atendedor no encontrado.' });

    db.query(`
      UPDATE usuario
      SET rut = ?, nombre = ?, email = ?
      WHERE id_usuario = ?
    `, [rut, nombre, email, rows[0].id_usuario], errUpdate => {
      if (errUpdate) {
        if (errUpdate.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'El RUT o correo ya están registrados.' });
        }
        return res.status(500).json({ error: 'No se pudieron actualizar los datos del atendedor.' });
      }
      res.json({ success: true });
    });
  });
});

function insertarAtendedor(idUsuario, res) {
  const fechaHoy = new Date().toISOString().slice(0, 10);
  const sqlAtendedor = `INSERT INTO atendedor (fecha_contratacion, posee_licencia_medica, id_usuario) VALUES (?, FALSE, ?)`;

  db.query(sqlAtendedor, [fechaHoy, idUsuario], (err, resultAtendedor) => {
    if (err) {
      return db.query('DELETE FROM usuario WHERE id_usuario = ?', [idUsuario], errCleanup => {
        if (errCleanup) {
          console.error('No se pudo limpiar la cuenta incompleta:', errCleanup);
          return res.status(500).json({ error: 'No se pudo crear ni limpiar la cuenta del atendedor.' });
        }
        res.status(500).json({ error: 'Error al insertar atendedor: ' + err.message });
      });
    }
    res.json({ success: true });
  });
}

// 3. ACTUALIZAR LICENCIA (PUT)
app.put('/api/empleados/:id/licencia', autenticar, soloAdministrador, (req, res) => {
  const { id } = req.params;
  const { licencia } = req.body;
  if (typeof licencia !== 'boolean') {
    return res.status(400).json({ error: 'El estado de licencia no es válido.' });
  }

  const sql = `UPDATE atendedor SET posee_licencia_medica = ? WHERE id_atendedor = ?`;

  db.query(sql, [licencia ? 1 : 0, id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error al actualizar licencia: ' + err.message });
    if (result.affectedRows === 0) {
      return db.query('SELECT id_atendedor FROM atendedor WHERE id_atendedor = ?', [id], (errFind, rows) => {
        if (errFind) return res.status(500).json({ error: 'No se pudo validar el atendedor.' });
        if (rows.length === 0) return res.status(404).json({ error: 'Atendedor no encontrado.' });
        res.json({ success: true });
      });
    }
    res.json({ success: true });
  });
});

app.delete('/api/empleados/:id', autenticar, soloAdministrador, (req, res) => {
  db.query('UPDATE atendedor SET activo = 0 WHERE id_atendedor = ? AND activo = 1', [req.params.id], (err, result) => {
    if (err) return res.status(500).json({ error: 'No se pudo archivar el atendedor.' });
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Atendedor activo no encontrado.' });
    }
    res.json({ success: true, message: 'Atendedor archivado; se conservaron sus registros.' });
  });
});

app.put('/api/empleados/:id/estado', autenticar, soloAdministrador, (req, res) => {
  const { activo } = req.body;
  if (typeof activo !== 'boolean') {
    return res.status(400).json({ error: 'El estado del atendedor no es válido.' });
  }

  db.query('SELECT activo FROM atendedor WHERE id_atendedor = ?', [req.params.id], (errFind, rows) => {
    if (errFind) return res.status(500).json({ error: 'No se pudo validar el atendedor.' });
    if (rows.length === 0) return res.status(404).json({ error: 'Atendedor no encontrado.' });
    db.query('UPDATE atendedor SET activo = ? WHERE id_atendedor = ?', [activo ? 1 : 0, req.params.id], errUpdate => {
      if (errUpdate) return res.status(500).json({ error: 'No se pudo actualizar el estado del atendedor.' });
      res.json({ success: true });
    });
  });
});

// 4. OBTENER ADMINISTRADORES (GET)
app.get('/api/administradores', autenticar, soloAdministrador, (req, res) => {
  const sql = `SELECT adm.id_administrador AS id, adm.departamento, adm.activo,
                      u.rut, u.nombre, u.email
               FROM administrador adm
               INNER JOIN usuario u ON adm.id_usuario = u.id_usuario
               ORDER BY adm.id_administrador ASC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// 5. GUARDAR NUEVO ADMINISTRADOR (POST)
app.post('/api/administradores', autenticar, soloAdministrador, (req, res) => {
  const { rut, nombre, email, password } = req.body;
  const departamento = typeof req.body.departamento === 'string'
    ? req.body.departamento.trim()
    : '';
  if (!rut || !nombre || !email || !password || !departamento) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }
  if (departamento.length > 100) {
    return res.status(400).json({ error: 'El departamento no puede superar los 100 caracteres.' });
  }
  if (!esContrasenaSegura(password)) {
    return res.status(400).json({
      error: 'La contraseña debe tener entre 8 y 128 caracteres e incluir mayúscula, minúscula, número y símbolo.'
    });
  }

  hashContrasena(password).then(passwordHash => {
    const sqlUser = `INSERT INTO usuario (rut, hash_contrasena, email, nombre, debe_cambiar_contrasena) VALUES (?, ?, ?, ?, 0)`;

    db.query(sqlUser, [rut, passwordHash, email, nombre], (err, resultUser) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ error: 'El correo electrónico o RUT ya se encuentran registrados.' });
        }
        return res.status(500).json({ error: 'Error al insertar usuario: ' + err.message });
      }

      const sqlAdmin = `INSERT INTO administrador (departamento, id_usuario) VALUES (?, ?)`;
      db.query(sqlAdmin, [departamento, resultUser.insertId], (errAdmin) => {
        if (errAdmin) {
          return db.query('DELETE FROM usuario WHERE id_usuario = ?', [resultUser.insertId], errCleanup => {
            if (errCleanup) {
              console.error('No se pudo limpiar la cuenta incompleta:', errCleanup);
              return res.status(500).json({ error: 'No se pudo crear ni limpiar la cuenta de administrador.' });
            }
            res.status(500).json({ error: 'Error al insertar administrador: ' + errAdmin.message });
          });
        }
        res.json({ success: true, message: 'Administrador creado correctamente' });
      });
    });
  }).catch(err => {
    console.error('Error al proteger la contraseña del administrador:', err);
    res.status(500).json({ error: 'No se pudo proteger la contraseña del administrador.' });
  });
});

app.put('/api/administradores/:id', autenticar, soloAdministrador, (req, res) => {
  const rut = typeof req.body.rut === 'string' ? req.body.rut.trim() : '';
  const nombre = typeof req.body.nombre === 'string' ? req.body.nombre.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  const departamento = typeof req.body.departamento === 'string' ? req.body.departamento.trim() : '';
  if (!rut || !nombre || !email || !departamento ||
      rut.length > 15 || nombre.length > 20 || email.length > 100 || departamento.length > 100) {
    return res.status(400).json({ error: 'Ingresa RUT, nombre, correo y departamento dentro de los límites permitidos.' });
  }

  db.query('SELECT id_usuario FROM administrador WHERE id_administrador = ?', [req.params.id], (errFind, rows) => {
    if (errFind) return res.status(500).json({ error: 'No se pudo validar el administrador.' });
    if (rows.length === 0) return res.status(404).json({ error: 'Administrador no encontrado.' });

    db.query(`
      UPDATE usuario u
      INNER JOIN administrador adm ON adm.id_usuario = u.id_usuario
      SET u.rut = ?, u.nombre = ?, u.email = ?, adm.departamento = ?
      WHERE adm.id_administrador = ?
    `, [rut, nombre, email, departamento, req.params.id], errUpdate => {
      if (errUpdate) {
        if (errUpdate.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'El RUT o correo ya están registrados.' });
        }
        return res.status(500).json({ error: 'No se pudieron actualizar los datos del administrador.' });
      }
      res.json({ success: true });
    });
  });
});

app.put('/api/administradores/:id/estado', autenticar, soloAdministrador, (req, res) => {
  const { activo } = req.body;
  if (typeof activo !== 'boolean') {
    return res.status(400).json({ error: 'El estado del administrador no es válido.' });
  }
  if (!activo && Number(req.params.id) === Number(req.auth.idAdministrador)) {
    return res.status(409).json({ error: 'No puedes archivar tu propia cuenta de administrador.' });
  }

  db.query('SELECT activo FROM administrador WHERE id_administrador = ?', [req.params.id], (errFind, rows) => {
    if (errFind) return res.status(500).json({ error: 'No se pudo validar el administrador.' });
    if (rows.length === 0) return res.status(404).json({ error: 'Administrador no encontrado.' });
    if (Boolean(rows[0].activo) === activo) return res.json({ success: true });

    const actualizar = () => {
      db.query('UPDATE administrador SET activo = ? WHERE id_administrador = ?', [activo ? 1 : 0, req.params.id], errUpdate => {
        if (errUpdate) return res.status(500).json({ error: 'No se pudo actualizar el estado del administrador.' });
        res.json({ success: true });
      });
    };
    if (activo) return actualizar();

    db.query('SELECT COUNT(*) AS total FROM administrador WHERE activo = 1', (errCount, counts) => {
      if (errCount) return res.status(500).json({ error: 'No se pudo validar la cantidad de administradores activos.' });
      if (counts[0].total <= 1) {
        return res.status(409).json({ error: 'Debe mantenerse al menos un administrador activo.' });
      }
      actualizar();
    });
  });
});

// 6. SOLICITUDES DE DÍA LIBRE Y LICENCIA
app.get('/api/solicitudes', autenticar, (req, res) => {
  if (!solicitudSchemaReady) {
    return res.status(503).json({ error: 'La base de datos de solicitudes aún no está lista.' });
  }

  let sql = `
    SELECT s.id_solicitud, s.tipo_solicitud AS tipo,
           DATE_FORMAT(s.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
           DATE_FORMAT(s.fecha_termino, '%Y-%m-%d') AS fecha_fin,
           s.motivo, s.estado_solicitud AS estado,
           u.id_usuario, u.nombre, u.rut, u.email
    FROM solicituddialibre s
    INNER JOIN atendedor a ON a.id_atendedor = s.id_atendedor
    INNER JOIN usuario u ON u.id_usuario = a.id_usuario
  `;
  const params = [];

  if (req.auth.idAtendedor) {
    sql += ' WHERE u.id_usuario = ?';
    params.push(req.auth.idUsuario);
  }
  sql += ' ORDER BY s.fecha_creacion DESC';

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.post('/api/solicitudes', autenticar, soloAtendedor, (req, res) => {
  const { tipo, fecha_inicio, fecha_fin, motivo } = req.body;
  const motivoLimpio = typeof motivo === 'string' ? motivo.trim() : '';
  if (!solicitudSchemaReady) {
    return res.status(503).json({ error: 'La base de datos de solicitudes aún no está lista.' });
  }
  if (!['Dia libre', 'Licencia'].includes(tipo) ||
      !fechaISOValida(fecha_inicio) || !fechaISOValida(fecha_fin) || !motivoLimpio) {
    return res.status(400).json({ error: 'Completa todos los datos obligatorios.' });
  }
  if (fecha_fin < fecha_inicio) {
    return res.status(400).json({ error: 'La fecha final no puede ser anterior a la fecha inicial.' });
  }

  db.query(`
    SELECT a.id_atendedor
    FROM atendedor a
    WHERE a.id_usuario = ? AND a.activo = 1
  `, [req.auth.idUsuario], (err, atendedores) => {
    if (err) return res.status(500).json({ error: err.message });
    if (atendedores.length === 0) {
      return res.status(404).json({ error: 'No se encontró un atendedor asociado a esta cuenta.' });
    }

    db.query('SELECT id_administrador FROM administrador WHERE activo = 1 ORDER BY id_administrador LIMIT 1', (errAdmin, administradores) => {
      if (errAdmin) return res.status(500).json({ error: errAdmin.message });
      if (administradores.length === 0) {
        return res.status(409).json({ error: 'No hay un administrador registrado para revisar la solicitud.' });
      }

      const sql = `
        INSERT INTO solicituddialibre
          (fecha_solicitud, fecha_inicio, fecha_termino, tipo_solicitud,
           estado_solicitud, fecha_creacion, id_atendedor, id_administrador, motivo)
        VALUES (CURDATE(), ?, ?, ?, 'Pendiente', CURDATE(), ?, ?, ?)
      `;
      const params = [
        fecha_inicio,
        fecha_fin,
        tipo,
        atendedores[0].id_atendedor,
        administradores[0].id_administrador,
        motivoLimpio
      ];

      db.query(sql, params, (errInsert, result) => {
        if (errInsert) return res.status(500).json({ error: errInsert.message });
        res.json({ success: true, id: result.insertId });
      });
    });
  });
});

app.put('/api/solicitudes/:id', autenticar, (req, res) => {
  if (!solicitudSchemaReady) {
    return res.status(503).json({ error: 'La base de datos de solicitudes aún no está lista.' });
  }

  if (req.auth.idAdministrador) {
    const { estado } = req.body;
    if (!['Aprobada', 'Rechazada'].includes(estado)) {
      return res.status(400).json({ error: 'Estado de solicitud inválido.' });
    }

    db.query(
      `UPDATE solicituddialibre
       SET estado_solicitud = ?, id_administrador = ?
       WHERE id_solicitud = ? AND estado_solicitud = 'Pendiente'`,
      [estado, req.auth.idAdministrador, req.params.id],
      (err, result) => {
        if (err) return res.status(500).json({ error: 'No se pudo responder la solicitud.' });
        if (result.affectedRows === 0) {
          return res.status(404).json({ error: 'Solicitud pendiente no encontrada.' });
        }
        res.json({ success: true });
      }
    );
    return;
  }

  const { tipo, fecha_inicio, fecha_fin, motivo } = req.body;
  const motivoLimpio = typeof motivo === 'string' ? motivo.trim() : '';
  if (!['Dia libre', 'Licencia'].includes(tipo) ||
      !fechaISOValida(fecha_inicio) || !fechaISOValida(fecha_fin) || fecha_fin < fecha_inicio ||
      !motivoLimpio) {
    return res.status(400).json({ error: 'Completa la solicitud con valores válidos.' });
  }

  db.query(`
    SELECT s.id_solicitud
    FROM solicituddialibre s
    INNER JOIN atendedor a ON a.id_atendedor = s.id_atendedor
    WHERE s.id_solicitud = ? AND s.estado_solicitud = 'Pendiente'
      AND a.id_usuario = ? AND a.activo = 1
  `, [req.params.id, req.auth.idUsuario], (errFind, rows) => {
    if (errFind) return res.status(500).json({ error: 'No se pudo validar la solicitud.' });
    if (rows.length === 0) return res.status(404).json({ error: 'Solicitud pendiente propia no encontrada.' });
    db.query(`
      UPDATE solicituddialibre
      SET tipo_solicitud = ?, fecha_inicio = ?, fecha_termino = ?, motivo = ?
      WHERE id_solicitud = ? AND estado_solicitud = 'Pendiente'
    `, [tipo, fecha_inicio, fecha_fin, motivoLimpio, req.params.id], errUpdate => {
      if (errUpdate) return res.status(500).json({ error: 'No se pudo editar la solicitud.' });
      res.json({ success: true });
    });
  });
});

app.delete('/api/solicitudes/:id', autenticar, (req, res) => {
  if (!solicitudSchemaReady) {
    return res.status(503).json({ error: 'La base de datos de solicitudes aún no está lista.' });
  }
  const admin = Boolean(req.auth.idAdministrador);
  const sql = `
    UPDATE solicituddialibre s
    INNER JOIN atendedor a ON a.id_atendedor = s.id_atendedor
    SET s.estado_solicitud = 'Cancelada'
    WHERE s.id_solicitud = ? AND s.estado_solicitud = 'Pendiente'
      ${admin ? '' : 'AND a.id_usuario = ? AND a.activo = 1'}
  `;
  const params = admin
    ? [req.params.id]
    : [req.params.id, req.auth.idUsuario];

  db.query(sql, params, (err, result) => {
    if (err) return res.status(500).json({ error: 'No se pudo cancelar la solicitud.' });
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Solicitud pendiente no encontrada o sin permiso para cancelarla.' });
    }
    res.json({ success: true, message: 'Solicitud cancelada; se conservó el historial.' });
  });
});

app.delete('/api/administradores/:id', autenticar, soloAdministrador, (req, res) => {
  const id = Number(req.params.id);
  if (id === Number(req.auth.idAdministrador)) {
    return res.status(409).json({ error: 'No puedes archivar tu propia cuenta de administrador.' });
  }

  db.query('SELECT activo FROM administrador WHERE id_administrador = ?', [id], (errFind, rows) => {
    if (errFind) return res.status(500).json({ error: 'No se pudo validar el administrador.' });
    if (rows.length === 0 || !rows[0].activo) return res.status(404).json({ error: 'Administrador activo no encontrado.' });
    db.query('SELECT COUNT(*) AS total FROM administrador WHERE activo = 1', (errCount, counts) => {
      if (errCount) return res.status(500).json({ error: 'No se pudo validar la cantidad de administradores activos.' });
      if (counts[0].total <= 1) {
        return res.status(409).json({ error: 'Debe mantenerse al menos un administrador activo.' });
      }
      db.query('UPDATE administrador SET activo = 0 WHERE id_administrador = ?', [id], errArchive => {
        if (errArchive) return res.status(500).json({ error: 'No se pudo archivar el administrador.' });
        res.json({ success: true, message: 'Administrador archivado; se conservaron sus registros.' });
      });
    });
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(3000, () => {
  console.log('Servidor corriendo en http://localhost:3000');
});