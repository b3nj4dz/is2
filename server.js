const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

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

let solicitudSchemaReady = false;
let autenticacionSchemaReady = false;

db.connect(err => {
  if (err) {
    console.error('Error al conectar a MariaDB:', err);
  } else {
    console.log('Conectado exitosamente a la base de datos gestion_turnos_copec en XAMPP');
    const columnas = [
      ['solicituddialibre', 'motivo', 'TEXT NULL'],
      ['usuario', 'intentos_fallidos', 'INT NOT NULL DEFAULT 0'],
      ['usuario', 'bloqueado', 'TINYINT(1) NOT NULL DEFAULT 0']
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
          solicitudSchemaReady = true;
          autenticacionSchemaReady = true;
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
  if (!email || !password) return res.status(400).json({ error: 'Ingresa correo y contraseña' });
  if (!autenticacionSchemaReady) {
    return res.status(503).json({ error: 'La autenticación aún no está lista. Intenta nuevamente.' });
  }

  const sql = `
    SELECT u.id_usuario, u.rut, u.nombre, u.email, u.hash_contrasena,
           u.intentos_fallidos, u.bloqueado,
           adm.id_administrador, at.id_atendedor
    FROM usuario u
    LEFT JOIN administrador adm ON u.id_usuario = adm.id_usuario
    LEFT JOIN atendedor at ON u.id_usuario = at.id_usuario
    WHERE u.email = ?
  `;

  db.query(sql, [email], (err, results) => {
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

    if (user.hash_contrasena !== password) {
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

    db.query('UPDATE usuario SET intentos_fallidos = 0 WHERE id_usuario = ?', [user.id_usuario], errReset => {
      if (errReset) return res.status(500).json({ error: errReset.message });
      const esAdmin = Boolean(user.id_administrador);
      res.json({
        success: true,
        usuario: {
          id: user.id_usuario,
          rut: user.rut,
          nombre: user.nombre || user.email,
          email: user.email,
          rol: esAdmin ? 'admin' : 'atendedor'
        }
      });
    });
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

app.get('/api/solicitudes-desbloqueo', (req, res) => {
  if (!autenticacionSchemaReady) {
    return res.status(503).json({ error: 'La autenticación aún no está lista. Intenta nuevamente.' });
  }
  if (req.query.rol !== 'admin') {
    return res.status(403).json({ error: 'Acceso reservado a administradores.' });
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

app.put('/api/solicitudes-desbloqueo/:id', (req, res) => {
  if (!autenticacionSchemaReady) {
    return res.status(503).json({ error: 'La autenticación aún no está lista. Intenta nuevamente.' });
  }
  const { estado, id_usuario } = req.body;
  if (!['Aprobada', 'Rechazada'].includes(estado) || !id_usuario) {
    return res.status(400).json({ error: 'La respuesta y el administrador son obligatorios.' });
  }

  db.query(
    'SELECT id_administrador FROM administrador WHERE id_usuario = ?',
    [id_usuario],
    (errAdmin, admins) => {
      if (errAdmin) return res.status(500).json({ error: errAdmin.message });
      if (admins.length === 0) {
        return res.status(403).json({ error: 'Acceso reservado a administradores.' });
      }

      const idAdministrador = admins[0].id_administrador;
      db.query(`
        UPDATE solicituddesbloqueo s
        INNER JOIN usuario u ON u.id_usuario = s.id_usuario
        SET s.estado_solicitud = ?,
            s.id_administrador = ?,
            s.fecha_respuesta = CURRENT_TIMESTAMP,
            u.bloqueado = IF(? = 'Aprobada', 0, u.bloqueado),
            u.intentos_fallidos = IF(? = 'Aprobada', 0, u.intentos_fallidos)
        WHERE s.id_solicitud = ? AND s.estado_solicitud = 'Pendiente'
      `, [estado, idAdministrador, estado, estado, req.params.id], (errUpdate, result) => {
        if (errUpdate) return res.status(500).json({ error: errUpdate.message });
        if (result.affectedRows === 0) {
          return res.status(404).json({ error: 'Solicitud pendiente no encontrada.' });
        }
        res.json({ success: true });
      });
    }
  );
});

app.get('/api/asistencia', (req, res) => {
  const { id_usuario, rol } = req.query;
  if (rol !== 'admin' || !id_usuario) {
    return res.status(403).json({ error: 'Acceso reservado a administradores.' });
  }

  db.query(
    'SELECT id_administrador FROM administrador WHERE id_usuario = ?',
    [id_usuario],
    (errAdmin, admins) => {
      if (errAdmin) return res.status(500).json({ error: errAdmin.message });
      if (admins.length === 0) {
        return res.status(403).json({ error: 'Acceso reservado a administradores.' });
      }

      db.query(`
        SELECT r.id_registro AS id,
               DATE_FORMAT(r.fecha, '%Y-%m-%d') AS fecha,
               r.horas_normales AS ordinarias,
               r.horas_extras AS extras,
               r.origen_registro AS origen,
               u.nombre
        FROM registroasistencia r
        INNER JOIN atendedor a ON a.id_atendedor = r.id_atendedor
        INNER JOIN usuario u ON u.id_usuario = a.id_usuario
        ORDER BY r.fecha DESC, r.id_registro DESC
      `, (err, registros) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(registros);
      });
    }
  );
});

app.post('/api/asistencia', (req, res) => {
  const { id_atendedor, id_usuario, fecha, horas_normales, horas_extras, origen_registro } = req.body;
  const horasNormales = Number(horas_normales);
  const horasExtras = Number(horas_extras);
  const origen = typeof origen_registro === 'string' ? origen_registro.trim() : '';
  const fechaDate = new Date(`${fecha || ''}T00:00:00.000Z`);
  const fechaValida = /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') &&
    !Number.isNaN(fechaDate.getTime()) &&
    fechaDate.toISOString().slice(0, 10) === fecha;

  if (!Number.isInteger(Number(id_atendedor)) || Number(id_atendedor) <= 0 ||
      !Number.isInteger(Number(id_usuario)) || Number(id_usuario) <= 0 ||
      !fechaValida ||
      horas_normales === undefined || horas_normales === null || horas_normales === '' ||
      horas_extras === undefined || horas_extras === null || horas_extras === '' ||
      !Number.isFinite(horasNormales) || horasNormales < 0 ||
      !Number.isFinite(horasExtras) || horasExtras < 0 ||
      !origen || origen.length > 50) {
    return res.status(400).json({ error: 'Completa los datos de asistencia con valores válidos.' });
  }

  db.query(
    'SELECT id_administrador FROM administrador WHERE id_usuario = ?',
    [id_usuario],
    (errAdmin, admins) => {
      if (errAdmin) return res.status(500).json({ error: errAdmin.message });
      if (admins.length === 0) {
        return res.status(403).json({ error: 'Acceso reservado a administradores.' });
      }

      db.query(
        'SELECT id_atendedor FROM atendedor WHERE id_atendedor = ?',
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
            admins[0].id_administrador
          ], (errInsert, result) => {
            if (errInsert) return res.status(500).json({ error: errInsert.message });
            res.json({ success: true, id: result.insertId });
          });
        }
      );
    }
  );
});

// 1. OBTENER EMPLEADOS (GET)
app.get('/api/empleados', (req, res) => {
  const sql = `SELECT a.id_atendedor AS id, u.id_usuario, u.rut, u.nombre AS nombre, u.email, a.posee_licencia_medica AS licencia
               FROM atendedor a
               INNER JOIN usuario u ON a.id_usuario = u.id_usuario 
               ORDER BY a.id_atendedor ASC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    const empleadosFormateados = results.map(row => ({
      ...row,
      licencia: Boolean(row.licencia)
    }));
    res.json(empleadosFormateados);
  });
});

// 2. GUARDAR NUEVO ATENDEDOR CON CORREO PERSONAL (POST)
app.post('/api/empleados', (req, res) => {
  const { rut, nombre, email } = req.body;
  if (!rut || !nombre || !email) return res.status(400).json({ error: 'Faltan datos obligatorios' });

  const passDefault = '123456';
  const sqlUser = `INSERT INTO usuario (rut, hash_contrasena, email, nombre) VALUES (?, ?, ?, ?)`;

  db.query(sqlUser, [rut, passDefault, email, nombre], (err, resultUser) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: 'El correo electrónico o RUT ya se encuentran registrados.' });
      }
      return res.status(500).json({ error: 'Error al insertar usuario: ' + err.message });
    }

    insertarAtendedor(resultUser.insertId, res);
  });
});

function insertarAtendedor(idUsuario, res) {
  const fechaHoy = new Date().toISOString().slice(0, 10);
  const sqlAtendedor = `INSERT INTO atendedor (fecha_contratacion, posee_licencia_medica, id_usuario) VALUES (?, FALSE, ?)`;

  db.query(sqlAtendedor, [fechaHoy, idUsuario], (err, resultAtendedor) => {
    if (err) return res.status(500).json({ error: 'Error al insertar atendedor: ' + err.message });
    res.json({ success: true });
  });
}

// 3. ACTUALIZAR LICENCIA (PUT)
app.put('/api/empleados/:id/licencia', (req, res) => {
  const { id } = req.params;
  const { licencia } = req.body;

  const sql = `UPDATE atendedor SET posee_licencia_medica = ? WHERE id_atendedor = ?`;

  db.query(sql, [licencia ? 1 : 0, id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error al actualizar licencia: ' + err.message });
    res.json({ success: true });
  });
});

// 4. OBTENER ADMINISTRADORES (GET)
app.get('/api/administradores', (req, res) => {
  const sql = `SELECT adm.id_administrador AS id, u.rut, u.nombre, u.email
               FROM administrador adm
               INNER JOIN usuario u ON adm.id_usuario = u.id_usuario
               ORDER BY adm.id_administrador ASC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// 5. GUARDAR NUEVO ADMINISTRADOR (POST)
app.post('/api/administradores', (req, res) => {
  const { rut, nombre, email, password } = req.body;
  if (!rut || !nombre || !email || !password) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

  const sqlUser = `INSERT INTO usuario (rut, hash_contrasena, email, nombre) VALUES (?, ?, ?, ?)`;

  db.query(sqlUser, [rut, password, email, nombre], (err, resultUser) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: 'El correo electrónico o RUT ya se encuentran registrados.' });
      }
      return res.status(500).json({ error: 'Error al insertar usuario: ' + err.message });
    }

    const sqlAdmin = `INSERT INTO administrador (id_usuario) VALUES (?)`;
    db.query(sqlAdmin, [resultUser.insertId], (errAdmin) => {
      if (errAdmin) return res.status(500).json({ error: 'Error al insertar administrador: ' + errAdmin.message });
      res.json({ success: true, message: 'Administrador creado correctamente' });
    });
  });
});

// 6. SOLICITUDES DE DÍA LIBRE Y LICENCIA
app.get('/api/solicitudes', (req, res) => {
  const { id_usuario, rol } = req.query;
  if (!solicitudSchemaReady) {
    return res.status(503).json({ error: 'La base de datos de solicitudes aún no está lista.' });
  }
  if (rol !== 'admin' && !id_usuario) {
    return res.status(400).json({ error: 'Falta identificar al usuario.' });
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

  if (rol !== 'admin' && id_usuario) {
    sql += ' WHERE u.id_usuario = ?';
    params.push(id_usuario);
  }
  sql += ' ORDER BY s.fecha_creacion DESC';

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.post('/api/solicitudes', (req, res) => {
  const { id_usuario, tipo, fecha_inicio, fecha_fin, motivo } = req.body;
  if (!solicitudSchemaReady) {
    return res.status(503).json({ error: 'La base de datos de solicitudes aún no está lista.' });
  }
  if (!id_usuario || !['Dia libre', 'Licencia'].includes(tipo) || !fecha_inicio || !fecha_fin || !motivo) {
    return res.status(400).json({ error: 'Completa todos los datos obligatorios.' });
  }
  if (fecha_fin < fecha_inicio) {
    return res.status(400).json({ error: 'La fecha final no puede ser anterior a la fecha inicial.' });
  }

  db.query(`
    SELECT a.id_atendedor
    FROM atendedor a
    WHERE a.id_usuario = ?
  `, [id_usuario], (err, atendedores) => {
    if (err) return res.status(500).json({ error: err.message });
    if (atendedores.length === 0) {
      return res.status(404).json({ error: 'No se encontró un atendedor asociado a esta cuenta.' });
    }

    db.query('SELECT id_administrador FROM administrador ORDER BY id_administrador LIMIT 1', (errAdmin, administradores) => {
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
        motivo.trim()
      ];

      db.query(sql, params, (errInsert, result) => {
        if (errInsert) return res.status(500).json({ error: errInsert.message });
        res.json({ success: true, id: result.insertId });
      });
    });
  });
});

app.put('/api/solicitudes/:id', (req, res) => {
  const { estado } = req.body;
  if (!solicitudSchemaReady) {
    return res.status(503).json({ error: 'La base de datos de solicitudes aún no está lista.' });
  }
  if (!['Aprobada', 'Rechazada'].includes(estado)) {
    return res.status(400).json({ error: 'Estado de solicitud inválido.' });
  }

  db.query(
    `UPDATE solicituddialibre
     SET estado_solicitud = ?
     WHERE id_solicitud = ? AND estado_solicitud = 'Pendiente'`,
    [estado, req.params.id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Solicitud pendiente no encontrada.' });
      }
      res.json({ success: true });
    }
  );
});

// 7. ELIMINAR ADMINISTRADOR (DELETE)
app.delete('/api/administradores/:id', (req, res) => {
  const { id } = req.params;

  const sqlFind = `SELECT id_usuario FROM administrador WHERE id_administrador = ?`;
  db.query(sqlFind, [id], (err, results) => {
    if (err || results.length === 0) return res.status(404).json({ error: 'Administrador no encontrado' });
    const idUsuario = results[0].id_usuario;

    db.query(`DELETE FROM administrador WHERE id_administrador = ?`, [id], (errDelAdmin) => {
      if (errDelAdmin) return res.status(500).json({ error: 'Error al eliminar administrador' });

      db.query(`DELETE FROM usuario WHERE id_usuario = ?`, [idUsuario], (errDelUser) => {
        if (errDelUser) return res.status(500).json({ error: 'Error al eliminar usuario base' });
        res.json({ success: true, message: 'Administrador eliminado con éxito' });
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