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
const publicDirectory = path.join(__dirname, '..', 'public');
app.use(cors());
app.use(express.json());
app.use(express.static(publicDirectory));

// Pool de conexiones MariaDB de XAMPP
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'gestion_turnos_copec',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

function consulta(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

function consultarEnConexion(conexion, sql, params = []) {
  return new Promise((resolve, reject) => {
    conexion.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

async function ejecutarTransaccion(operacion) {
  const conexion = await new Promise((resolve, reject) => {
    db.getConnection((err, connection) => err ? reject(err) : resolve(connection));
  });

  try {
    await new Promise((resolve, reject) => {
      conexion.beginTransaction(err => err ? reject(err) : resolve());
    });
    const resultado = await operacion((sql, params = []) =>
      consultarEnConexion(conexion, sql, params)
    );
    await new Promise((resolve, reject) => {
      conexion.commit(err => err ? reject(err) : resolve());
    });
    return resultado;
  } catch (err) {
    await new Promise(resolve => {
      conexion.rollback(errorRollback => {
        if (errorRollback) console.error('Error al revertir una transacción:', errorRollback);
        resolve();
      });
    });
    throw err;
  } finally {
    conexion.release();
  }
}

function fechaISOValida(fecha) {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const parsed = new Date(`${fecha}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === fecha;
}

function sumarDiasISO(fecha, cantidad) {
  const dia = new Date(`${fecha}T00:00:00.000Z`);
  dia.setUTCDate(dia.getUTCDate() + cantidad);
  return dia.toISOString().slice(0, 10);
}

function obtenerInicioSemanaISO(fecha) {
  const dia = new Date(`${fecha}T00:00:00.000Z`);
  dia.setUTCDate(dia.getUTCDate() - ((dia.getUTCDay() + 6) % 7));
  return dia.toISOString().slice(0, 10);
}

function esLunesISO(fecha) {
  return fechaISOValida(fecha) && new Date(`${fecha}T00:00:00.000Z`).getUTCDay() === 1;
}

function restarMesesISO(fecha, meses) {
  const dia = new Date(`${fecha}T00:00:00.000Z`);
  const diaDelMes = dia.getUTCDate();
  dia.setUTCDate(1);
  dia.setUTCMonth(dia.getUTCMonth() - meses);
  const ultimoDiaDelMes = new Date(Date.UTC(dia.getUTCFullYear(), dia.getUTCMonth() + 1, 0)).getUTCDate();
  dia.setUTCDate(Math.min(diaDelMes, ultimoDiaDelMes));
  return dia.toISOString().slice(0, 10);
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

async function migrarEsquemaNotificaciones() {
  const columnas = await consulta('SHOW COLUMNS FROM notificacion');
  const porNombre = new Map(columnas.map(columna => [columna.Field, columna]));
  const tipo = porNombre.get('tipo');

  if (!tipo) {
    await consulta(`
      ALTER TABLE notificacion
      ADD COLUMN tipo VARCHAR(20) NOT NULL DEFAULT 'cambio' AFTER id_usuario
    `);
  } else if (tipo.Type.toLowerCase() !== 'varchar(20)' ||
      tipo.Null !== 'NO' || tipo.Default !== 'cambio') {
    await consulta(`
      ALTER TABLE notificacion
      MODIFY COLUMN tipo VARCHAR(20) NOT NULL DEFAULT 'cambio'
    `);
  }

  const fechaCreacion = porNombre.get('fecha_creacion');
  if (!fechaCreacion) {
    if (porNombre.has('fecha_envio')) {
      await consulta(`
        ALTER TABLE notificacion
        CHANGE COLUMN fecha_envio fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      `);
    } else {
      await consulta(`
        ALTER TABLE notificacion
        ADD COLUMN fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      `);
    }
  } else if (!fechaCreacion.Type.toLowerCase().startsWith('timestamp') ||
      fechaCreacion.Null !== 'NO' ||
      !/^current_timestamp(?:\(\))?$/i.test(String(fechaCreacion.Default))) {
    await consulta(`
      ALTER TABLE notificacion
      MODIFY COLUMN fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    `);
  }

  const leida = porNombre.get('leida');
  if (!leida) {
    if (porNombre.has('estado_lectura')) {
      await consulta('UPDATE notificacion SET estado_lectura = 0 WHERE estado_lectura IS NULL');
      await consulta(`
        ALTER TABLE notificacion
        CHANGE COLUMN estado_lectura leida TINYINT(1) NOT NULL DEFAULT 0
      `);
    } else {
      await consulta(`
        ALTER TABLE notificacion
        ADD COLUMN leida TINYINT(1) NOT NULL DEFAULT 0
      `);
    }
  } else if (leida.Type.toLowerCase() !== 'tinyint(1)' ||
      leida.Null !== 'NO' || String(leida.Default) !== '0') {
    await consulta('UPDATE notificacion SET leida = 0 WHERE leida IS NULL');
    await consulta(`
      ALTER TABLE notificacion
      MODIFY COLUMN leida TINYINT(1) NOT NULL DEFAULT 0
    `);
  }
}

let solicitudSchemaReady = false;
let autenticacionSchemaReady = false;
let horariosSchemaReady = false;
let ausenciasSchemaReady = false;
let historialTurnosSchemaReady = false;
let parametrosTemporadaSchemaReady = false;
let parametrosCoberturaSchemaReady = false;
let notificacionesSchemaReady = false;
const tokensCambioContrasena = new Map();
const sesiones = new Map();
const conexionesNotificaciones = new Map();
const DURACION_SESION_MS = 8 * 60 * 60 * 1000;

async function guardarHistorialSemana(horarios, semanaInicio, consultar = consulta) {
  if (!historialTurnosSchemaReady || !ausenciasSchemaReady) {
    throw new Error('El historial de turnos aún no está listo.');
  }

  const ids = horarios.map(horario => Number(horario.id_atendedor));
  const semanaTermino = sumarDiasISO(semanaInicio, 6);
  const [atendedores, ausencias] = await Promise.all([
    consultar(
      'SELECT id_atendedor, posee_licencia_medica FROM atendedor WHERE id_atendedor IN (?)',
      [ids]
    ),
    consultar(`
      SELECT id_atendedor,
             DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
             DATE_FORMAT(fecha_termino, '%Y-%m-%d') AS fecha_termino
      FROM ausencia_atendedor
      WHERE id_atendedor IN (?) AND fecha_inicio <= ? AND fecha_termino >= ?
    `, [ids, semanaTermino, semanaInicio])
  ]);
  const licenciasIndefinidas = new Set(atendedores
    .filter(atendedor => Boolean(atendedor.posee_licencia_medica))
    .map(atendedor => Number(atendedor.id_atendedor)));
  const ausenciasPorAtendedor = new Map();
  ausencias.forEach(ausencia => {
    const idAtendedor = Number(ausencia.id_atendedor);
    if (!ausenciasPorAtendedor.has(idAtendedor)) ausenciasPorAtendedor.set(idAtendedor, []);
    ausenciasPorAtendedor.get(idAtendedor).push(ausencia);
  });
  const valores = [];
  horarios.forEach(horario => {
    const idAtendedor = Number(horario.id_atendedor);
    const ausenciasAtendedor = ausenciasPorAtendedor.get(idAtendedor) || [];
    horario.turnos.forEach((turno, dia) => {
      const fecha = sumarDiasISO(semanaInicio, dia);
      const ausente = licenciasIndefinidas.has(idAtendedor) || ausenciasAtendedor.some(ausencia =>
        ausencia.fecha_inicio <= fecha && ausencia.fecha_termino >= fecha
      );
      valores.push([idAtendedor, fecha, ausente ? 'libre' : turno]);
    });
  });

  await consultar(`
    INSERT INTO historialturnos (id_atendedor, fecha, turno)
    VALUES ?
    ON DUPLICATE KEY UPDATE turno = VALUES(turno)
  `, [valores]);
  return valores.length;
}

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

function emitirActualizacionNotificaciones(idUsuario) {
  const conexiones = conexionesNotificaciones.get(idUsuario);
  if (!conexiones) return;

  for (const conexion of [...conexiones]) {
    if (conexion.destroyed || conexion.writableEnded) {
      conexiones.delete(conexion);
      continue;
    }

    try {
      conexion.write('event: notificacion\ndata: {"actualizar":true}\n\n');
    } catch (err) {
      console.error('Error al enviar una notificación en tiempo real:', err);
      conexion.end();
      conexiones.delete(conexion);
    }
  }

  if (conexiones.size === 0) conexionesNotificaciones.delete(idUsuario);
}

async function registrarNotificaciones(consultar, idUsuarios, tipo, mensaje) {
  const destinatarios = [...new Set(idUsuarios.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (destinatarios.length === 0) return destinatarios;
  if (!notificacionesSchemaReady) throw new Error('Las notificaciones aún no están listas.');
  await consultar(
    'INSERT INTO notificacion (id_usuario, tipo, mensaje) VALUES ?',
    [destinatarios.map(idUsuario => [idUsuario, tipo, mensaje])]
  );
  return destinatarios;
}

function asegurarTipoDiaLibre(callback) {
  db.query("SHOW COLUMNS FROM ausencia_atendedor LIKE 'tipo'", (err, columnas) => {
    if (err) return callback(err);
    if (columnas.length > 0 && columnas[0].Type.includes("'dia_libre'")) return callback(null);
    db.query(`
      ALTER TABLE ausencia_atendedor
      MODIFY COLUMN tipo ENUM('licencia_medica', 'vacaciones', 'dia_libre') NOT NULL
    `, callback);
  });
}

db.query('SELECT 1', err => {
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
            db.query(`
              CREATE TABLE IF NOT EXISTS ausencia_atendedor (
                id_ausencia INT AUTO_INCREMENT PRIMARY KEY,
                id_atendedor INT NOT NULL,
                tipo ENUM('licencia_medica', 'vacaciones', 'dia_libre') NOT NULL,
                fecha_inicio DATE NOT NULL,
                fecha_termino DATE NOT NULL,
                observacion VARCHAR(255) NULL,
                fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY ausencia_atendedor_fechas (id_atendedor, fecha_inicio, fecha_termino),
                CONSTRAINT ausencia_atendedor_ibfk_1
                  FOREIGN KEY (id_atendedor) REFERENCES atendedor (id_atendedor) ON DELETE CASCADE
              ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `, errAbsenceTable => {
              if (errAbsenceTable) {
                console.error('Error al preparar la tabla de novedades y ausencias:', errAbsenceTable);
                return;
              }
              asegurarTipoDiaLibre(errTipoAusencia => {
                if (errTipoAusencia) {
                  console.error('Error al ampliar los tipos de ausencia:', errTipoAusencia);
                  return;
                }
                ausenciasSchemaReady = true;
              });
              db.query(`
                CREATE TABLE IF NOT EXISTS historialturnos (
                  id_atendedor INT NOT NULL,
                  fecha DATE NOT NULL,
                  turno ENUM('mañana', 'tarde', 'noche', 'libre') NOT NULL,
                  PRIMARY KEY (id_atendedor, fecha),
                  KEY historialturnos_fecha_turno (fecha, turno),
                  CONSTRAINT historialturnos_ibfk_1
                    FOREIGN KEY (id_atendedor) REFERENCES atendedor (id_atendedor) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
              `, errHistoryTable => {
                if (errHistoryTable) {
                  console.error('Error al preparar el historial de turnos:', errHistoryTable);
                  return;
                }
                historialTurnosSchemaReady = true;
                db.query(`
                  CREATE TABLE IF NOT EXISTS parametrotemporada (
                    clave VARCHAR(50) PRIMARY KEY,
                    valor VARCHAR(100) NOT NULL
                  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                `, errSeasonTable => {
                  if (errSeasonTable) {
                    console.error('Error al preparar la tabla de parámetros por temporada:', errSeasonTable);
                    return;
                  }
                  db.query(`
                    INSERT IGNORE INTO parametrotemporada (clave, valor) VALUES
                      ('modo', 'normal'),
                      ('horas_minimas_normal', '8'),
                      ('horas_minimas_verano', '9')
                  `, errDefaults => {
                    if (errDefaults) {
                      console.error('Error al inicializar los parámetros por temporada:', errDefaults);
                      return;
                    }
                    solicitudSchemaReady = true;
                    horariosSchemaReady = true;
                    parametrosTemporadaSchemaReady = true;
                    migrarContrasenasExistentes()
                      .then(() => {
                        autenticacionSchemaReady = true;
                        console.log('Contraseñas existentes protegidas con scrypt');
                      })
                      .catch(errMigration => {
                        console.error('Error al proteger las contraseñas existentes:', errMigration);
                      });

                    db.query(`
                      CREATE TABLE IF NOT EXISTS parametrocobertura (
                        turno ENUM('mañana', 'tarde', 'noche') PRIMARY KEY,
                        minimo INT UNSIGNED NOT NULL
                      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    `, errCoverageTable => {
                      if (errCoverageTable) {
                        console.error('Error al preparar la tabla de cobertura mínima:', errCoverageTable);
                        return;
                      }
                      db.query(`
                        INSERT IGNORE INTO parametrocobertura (turno, minimo) VALUES
                          ('mañana', 2),
                          ('tarde', 1),
                          ('noche', 2)
                      `, errCoverageDefaults => {
                        if (errCoverageDefaults) {
                          console.error('Error al inicializar los mínimos de cobertura:', errCoverageDefaults);
                          return;
                        }
                        parametrosCoberturaSchemaReady = true;
                        db.query(`
                          CREATE TABLE IF NOT EXISTS notificacion (
                            id_notificacion INT AUTO_INCREMENT PRIMARY KEY,
                            id_usuario INT NOT NULL,
                            tipo VARCHAR(20) NOT NULL,
                            mensaje VARCHAR(255) NOT NULL,
                            fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            leida TINYINT(1) NOT NULL DEFAULT 0,
                            KEY notificacion_usuario_fecha (id_usuario, fecha_creacion),
                            KEY notificacion_usuario_leida (id_usuario, leida),
                            CONSTRAINT notificacion_ibfk_1
                              FOREIGN KEY (id_usuario) REFERENCES usuario (id_usuario) ON DELETE CASCADE
                          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                        `, errNotificationTable => {
                          if (errNotificationTable) {
                            console.error('Error al preparar la tabla de notificaciones:', errNotificationTable);
                            return;
                          }
                          migrarEsquemaNotificaciones()
                            .then(() => {
                              notificacionesSchemaReady = true;
                            })
                            .catch(errMigration => {
                              console.error('Error al migrar la tabla de notificaciones:', errMigration);
                            });
                        });
                      });
                    });
                  });
                });
              });
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

app.get('/api/parametros-temporada', autenticar, (req, res) => {
  if (!parametrosTemporadaSchemaReady) {
    return res.status(503).json({ error: 'Los parámetros por temporada aún no están listos.' });
  }

  db.query(
    'SELECT clave, valor FROM parametrotemporada WHERE clave IN (?, ?, ?)',
    ['modo', 'horas_minimas_normal', 'horas_minimas_verano'],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'No se pudieron cargar los parámetros por temporada.' });

      const valores = Object.fromEntries(rows.map(row => [row.clave, row.valor]));
      const normal = Number(valores.horas_minimas_normal);
      const verano = Number(valores.horas_minimas_verano);
      res.json({
        modo: valores.modo === 'verano' ? 'verano' : 'normal',
        horas_minimas_normal: Number.isInteger(normal) ? Math.max(8, Math.min(12, normal)) : 8,
        horas_minimas_verano: Number.isInteger(verano) ? Math.max(8, Math.min(12, verano)) : 9
      });
    }
  );
});

app.put('/api/parametros-temporada', autenticar, soloAdministrador, (req, res) => {
  if (!parametrosTemporadaSchemaReady) {
    return res.status(503).json({ error: 'Los parámetros por temporada aún no están listos.' });
  }

  const { modo, horas_minimas_normal, horas_minimas_verano } = req.body;
  const normal = Number(horas_minimas_normal);
  const verano = Number(horas_minimas_verano);

  if (!['normal', 'verano'].includes(modo) ||
      !Number.isInteger(normal) || normal < 8 || normal > 12 ||
      !Number.isInteger(verano) || verano < 8 || verano > 12) {
    return res.status(400).json({
      error: 'Modo inválido o la duración de cada turno debe ser un número entero entre 8 y 12 horas.'
    });
  }

  db.query(
    'SELECT clave, valor FROM parametrotemporada WHERE clave IN (?, ?, ?)',
    ['modo', 'horas_minimas_normal', 'horas_minimas_verano'],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'No se pudieron leer los parámetros actuales.' });

      const actuales = Object.fromEntries(rows.map(row => [row.clave, row.valor]));
      const modoActual = actuales.modo === 'verano' ? 'verano' : 'normal';
      const horasActuales = modoActual === 'verano'
        ? Number(actuales.horas_minimas_verano) || 9
        : Number(actuales.horas_minimas_normal) || 8;
      const horasNuevas = modo === 'verano' ? verano : normal;
      const cambioHorario = modo !== modoActual || horasNuevas !== horasActuales;
      if (cambioHorario && !notificacionesSchemaReady) {
        return res.status(503).json({ error: 'Las notificaciones aún no están listas; inténtalo nuevamente.' });
      }

      const valores = [
        ['modo', modo],
        ['horas_minimas_normal', String(normal)],
        ['horas_minimas_verano', String(verano)]
      ];
      db.query(
        'INSERT INTO parametrotemporada (clave, valor) VALUES ? ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
        [valores],
        errGuardar => {
          if (errGuardar) return res.status(500).json({ error: 'No se pudieron guardar los parámetros por temporada.' });

          const respuesta = { success: true, modo, horas_minimas_normal: normal, horas_minimas_verano: verano };
          if (!cambioHorario) return res.json({ ...respuesta, notificaciones: 0 });

          db.query('SELECT id_usuario FROM atendedor WHERE activo = 1 AND id_usuario IS NOT NULL', (errDestinatarios, destinatarios) => {
            if (errDestinatarios) {
              return res.status(500).json({
                error: 'Los parámetros se guardaron, pero no se pudieron consultar los atendedores para notificar.'
              });
            }
            if (destinatarios.length === 0) return res.json({ ...respuesta, notificaciones: 0 });

            const temporada = modo === 'verano' ? 'Modo Verano' : 'Modo Normal';
            const mensaje = `El ${temporada} ahora considera ${horasNuevas} h por turno. Revisa tu cuadrante.`;
            const filasNotificacion = destinatarios.map(destinatario => [
              destinatario.id_usuario,
              'cambio',
              mensaje
            ]);
            db.query(
              'INSERT INTO notificacion (id_usuario, tipo, mensaje) VALUES ?',
              [filasNotificacion],
              errNotificaciones => {
                if (errNotificaciones) {
                  console.error('Error al registrar las notificaciones del cambio de temporada:', errNotificaciones);
                  return res.status(500).json({
                    error: 'Los parámetros se guardaron, pero no se pudieron registrar las notificaciones.'
                  });
                }
                destinatarios.forEach(destinatario => emitirActualizacionNotificaciones(destinatario.id_usuario));
                res.json({ ...respuesta, notificaciones: destinatarios.length });
              }
            );
          });
        }
      );
    }
  );
});

app.get('/api/parametros-cobertura', autenticar, soloAdministrador, (req, res) => {
  if (!parametrosCoberturaSchemaReady) {
    return res.status(503).json({ error: 'Los parámetros de cobertura aún no están listos.' });
  }

  db.query(
    'SELECT turno, minimo FROM parametrocobertura',
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'No se pudieron cargar los mínimos de cobertura.' });
      if (rows.length !== 3) {
        return res.status(500).json({ error: 'La configuración de cobertura está incompleta.' });
      }

      const valores = Object.fromEntries(rows.map(row => [row.turno, Number(row.minimo)]));
      res.json({
        manana: valores['mañana'],
        tarde: valores.tarde,
        noche: valores.noche
      });
    }
  );
});

app.put('/api/parametros-cobertura', autenticar, soloAdministrador, (req, res) => {
  if (!parametrosCoberturaSchemaReady) {
    return res.status(503).json({ error: 'Los parámetros de cobertura aún no están listos.' });
  }

  const cuerpo = req.body || {};
  const valores = [
    ['mañana', Number(cuerpo.manana)],
    ['tarde', Number(cuerpo.tarde)],
    ['noche', Number(cuerpo.noche)]
  ];
  if (valores.some(([, minimo]) => !Number.isInteger(minimo) || minimo < 1 || minimo > 500)) {
    return res.status(400).json({ error: 'Cada mínimo debe ser un número entero entre 1 y 500.' });
  }

  db.query(`
    INSERT INTO parametrocobertura (turno, minimo) VALUES ?
    ON DUPLICATE KEY UPDATE minimo = VALUES(minimo)
  `, [valores], err => {
    if (err) return res.status(500).json({ error: 'No se pudieron guardar los mínimos de cobertura.' });
    res.json({
      success: true,
      manana: valores[0][1],
      tarde: valores[1][1],
      noche: valores[2][1]
    });
  });
});

app.get('/api/notificaciones', autenticar, soloAtendedor, (req, res) => {
  if (!notificacionesSchemaReady) {
    return res.status(503).json({ error: 'Las notificaciones aún no están listas.' });
  }

  db.query(`
    SELECT id_notificacion AS id, tipo, mensaje,
           DATE_FORMAT(fecha_creacion, '%Y-%m-%d %H:%i:%s') AS fecha_creacion,
           leida
    FROM notificacion
    WHERE id_usuario = ?
    ORDER BY fecha_creacion DESC, id_notificacion DESC
    LIMIT 50
  `, [req.auth.idUsuario], (err, notificaciones) => {
    if (err) return res.status(500).json({ error: 'No se pudieron cargar las notificaciones.' });
    db.query(
      'SELECT COUNT(*) AS no_leidas FROM notificacion WHERE id_usuario = ? AND leida = 0',
      [req.auth.idUsuario],
      (errCount, counts) => {
        if (errCount) return res.status(500).json({ error: 'No se pudo contar las notificaciones pendientes.' });
        res.json({ notificaciones, no_leidas: counts[0].no_leidas });
      }
    );
  });
});

app.put('/api/notificaciones/leidas', autenticar, soloAtendedor, (req, res) => {
  if (!notificacionesSchemaReady) {
    return res.status(503).json({ error: 'Las notificaciones aún no están listas.' });
  }

  db.query(
    'UPDATE notificacion SET leida = 1 WHERE id_usuario = ? AND leida = 0',
    [req.auth.idUsuario],
    err => {
      if (err) return res.status(500).json({ error: 'No se pudieron marcar las notificaciones como leídas.' });
      res.json({ success: true });
    }
  );
});

app.get('/api/notificaciones/stream', autenticar, soloAtendedor, (req, res) => {
  if (!notificacionesSchemaReady) {
    return res.status(503).json({ error: 'Las notificaciones aún no están listas.' });
  }

  const idUsuario = req.auth.idUsuario;
  const token = req.auth.token;
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  if (!conexionesNotificaciones.has(idUsuario)) {
    conexionesNotificaciones.set(idUsuario, new Set());
  }
  conexionesNotificaciones.get(idUsuario).add(res);

  const keepAlive = setInterval(() => {
    const sesion = sesiones.get(token);
    if (!sesion || sesion.expira <= Date.now()) {
      res.write('event: sesion-expirada\ndata: {}\n\n');
      res.end();
      return;
    }
    res.write(': keep-alive\n\n');
  }, 25000);

  res.on('close', () => {
    clearInterval(keepAlive);
    const conexiones = conexionesNotificaciones.get(idUsuario);
    if (!conexiones) return;
    conexiones.delete(res);
    if (conexiones.size === 0) conexionesNotificaciones.delete(idUsuario);
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

app.get('/api/historial-turnos', autenticar, soloAdministrador, async (req, res) => {
  if (!historialTurnosSchemaReady || !horariosSchemaReady || !ausenciasSchemaReady) {
    return res.status(503).json({ error: 'El historial de turnos aún no está listo.' });
  }
  const { semanaInicio } = req.query;
  if (!esLunesISO(semanaInicio)) {
    return res.status(400).json({ error: 'La semana debe comenzar un lunes válido.' });
  }

  try {
    const hoy = new Date();
    const hoyISO = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
    const semanaActual = obtenerInicioSemanaISO(hoyISO);
    const semanaActualTermino = sumarDiasISO(semanaActual, 6);
    const registrosSemanaActual = await consulta(
      'SELECT COUNT(*) AS cantidad FROM historialturnos WHERE fecha BETWEEN ? AND ?',
      [semanaActual, semanaActualTermino]
    );

    if (Number(registrosSemanaActual[0].cantidad) === 0) {
      const asignacionesActuales = await consulta(`
        SELECT h.id_atendedor, h.dia_semana, h.turno
        FROM asignacionsemanal h
        INNER JOIN atendedor a ON a.id_atendedor = h.id_atendedor
        WHERE a.activo = 1
        ORDER BY h.id_atendedor, h.dia_semana
      `);
      const horariosActuales = new Map();
      asignacionesActuales.forEach(asignacion => {
        const idAtendedor = Number(asignacion.id_atendedor);
        if (!horariosActuales.has(idAtendedor)) horariosActuales.set(idAtendedor, Array(7).fill(null));
        horariosActuales.get(idAtendedor)[asignacion.dia_semana] = asignacion.turno;
      });
      const semanaCompleta = [...horariosActuales.values()].every(turnos =>
        turnos.length === 7 && turnos.every(turno => turno)
      );
      if (horariosActuales.size > 0 && semanaCompleta) {
        await guardarHistorialSemana(
          [...horariosActuales].map(([id_atendedor, turnos]) => ({ id_atendedor, turnos })),
          semanaActual
        );
      }
    }

    const historial = await consulta(`
      SELECT id_atendedor, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, turno
      FROM historialturnos
      WHERE fecha >= ? AND fecha < ?
      ORDER BY fecha, id_atendedor
    `, [restarMesesISO(semanaInicio, 3), semanaInicio]);
    res.json(historial);
  } catch (err) {
    console.error('Error al consultar el historial de turnos:', err);
    res.status(500).json({ error: 'No se pudo consultar el historial de turnos.' });
  }
});

app.put('/api/horarios', autenticar, soloAdministrador, (req, res) => {
  if (!horariosSchemaReady) {
    return res.status(503).json({ error: 'La base de datos de horarios aún no está lista.' });
  }

  const cuerpo = req.body || {};
  const { horarios } = cuerpo;
  const { semanaInicio } = cuerpo;
  const tipoNotificacion = cuerpo.notificacion === undefined ? null : cuerpo.notificacion;
  const turnosValidos = new Set(['mañana', 'tarde', 'noche', 'libre']);
  const hoy = new Date();
  const hoyISO = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
  const semanaActual = obtenerInicioSemanaISO(hoyISO);
  if (!esLunesISO(semanaInicio)) {
    return res.status(400).json({ error: 'La semana debe comenzar un lunes válido.' });
  }
  if (semanaInicio < semanaActual) {
    return res.status(409).json({ error: 'No se pueden modificar horarios de semanas pasadas.' });
  }
  if (!historialTurnosSchemaReady || !ausenciasSchemaReady) {
    return res.status(503).json({ error: 'El historial de turnos aún no está listo.' });
  }
  if (tipoNotificacion !== null && !['cambio', 'publicacion'].includes(tipoNotificacion)) {
    return res.status(400).json({ error: 'El tipo de notificación no es válido.' });
  }
  if (tipoNotificacion && !notificacionesSchemaReady) {
    return res.status(503).json({ error: 'Las notificaciones aún no están listas.' });
  }
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
  db.query('SELECT id_atendedor, id_usuario FROM atendedor WHERE activo = 1 AND id_atendedor IN (?)', [ids], (errEmployees, rows) => {
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

    ejecutarTransaccion(async consultar => {
      let destinatarios = [];
      if (tipoNotificacion === 'publicacion') {
        destinatarios = rows.map(row => ({ id_usuario: row.id_usuario }));
      } else if (tipoNotificacion === 'cambio') {
        const asignacionesPrevias = await consultar(
          'SELECT id_atendedor, dia_semana, turno FROM asignacionsemanal WHERE id_atendedor IN (?) FOR UPDATE',
          [ids]
        );
        const horariosAnteriores = new Map();
        asignacionesPrevias.forEach(asignacion => {
          const idAtendedor = Number(asignacion.id_atendedor);
          if (!horariosAnteriores.has(idAtendedor)) {
            horariosAnteriores.set(idAtendedor, Array(7).fill(null));
          }
          horariosAnteriores.get(idAtendedor)[asignacion.dia_semana] = asignacion.turno;
        });
        const idUsuariosPorAtendedor = new Map(rows.map(row => [
          Number(row.id_atendedor),
          row.id_usuario
        ]));
        destinatarios = horarios.filter(horario => {
          const anterior = horariosAnteriores.get(Number(horario.id_atendedor));
          return !anterior || horario.turnos.some((turno, dia) => anterior[dia] !== turno);
        }).map(horario => ({
          id_usuario: idUsuariosPorAtendedor.get(Number(horario.id_atendedor))
        }));
      }

      const resultado = await consultar(`
        INSERT INTO asignacionsemanal (id_atendedor, dia_semana, turno)
        VALUES ?
        ON DUPLICATE KEY UPDATE turno = VALUES(turno)
      `, [valores]);
      await guardarHistorialSemana(horarios, semanaInicio, consultar);

      if (destinatarios.length > 0) {
        const mensaje = tipoNotificacion === 'publicacion'
          ? 'Se publicó un nuevo horario semanal. Revisa tu cuadrante.'
          : 'Tu horario fue modificado. Revisa tus turnos asignados.';
        const usuariosNotificados = await registrarNotificaciones(
          consultar,
          destinatarios.map(destinatario => destinatario.id_usuario),
          tipoNotificacion,
          mensaje
        );
        destinatarios = usuariosNotificados.map(id_usuario => ({ id_usuario }));
      }

      return {
        asignaciones: resultado.affectedRows,
        destinatarios: destinatarios.map(destinatario => destinatario.id_usuario)
      };
    }).then(resultado => {
      resultado.destinatarios.forEach(emitirActualizacionNotificaciones);
      res.json({
        success: true,
        asignaciones: resultado.asignaciones,
        notificaciones: resultado.destinatarios.length
      });
    }).catch(err => {
      console.error('Error al guardar la propuesta, historial o notificaciones:', err);
      res.status(500).json({ error: 'No se pudo guardar el horario, su historial y sus notificaciones.' });
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
    ejecutarTransaccion(async consultar => {
      const resultadoUsuario = await consultar(
        'INSERT INTO usuario (rut, hash_contrasena, email, nombre, debe_cambiar_contrasena) VALUES (?, ?, ?, ?, 0)',
        [rut, passwordHash, email, nombre]
      );
      await consultar(
        'INSERT INTO atendedor (fecha_contratacion, posee_licencia_medica, id_usuario) VALUES (?, FALSE, ?)',
        [new Date().toISOString().slice(0, 10), resultadoUsuario.insertId]
      );
    }).then(() => {
      res.json({ success: true });
    }).catch(err => {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: 'El correo electrónico o RUT ya se encuentran registrados.' });
      }
      console.error('Error al crear el usuario y el atendedor:', err);
      res.status(500).json({ error: 'No se pudo crear el usuario y el atendedor.' });
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

function validarDatosAusencia(cuerpo) {
  const idAtendedor = Number(cuerpo.id_atendedor);
  const tipo = cuerpo.tipo;
  const fechaInicio = cuerpo.fecha_inicio;
  const fechaTermino = cuerpo.fecha_termino;
  const observacion = typeof cuerpo.observacion === 'string' ? cuerpo.observacion.trim() : '';

  if (!Number.isInteger(idAtendedor) || idAtendedor <= 0 ||
      !['licencia_medica', 'vacaciones', 'dia_libre'].includes(tipo) ||
      !fechaISOValida(fechaInicio) || !fechaISOValida(fechaTermino) ||
      fechaTermino < fechaInicio ||
      (cuerpo.observacion !== undefined && cuerpo.observacion !== null && typeof cuerpo.observacion !== 'string') ||
      observacion.length > 255) {
    return { error: 'Atendedor, tipo, fechas o descripción de la novedad no válidos.' };
  }
  return {
    datos: {
      idAtendedor,
      tipo,
      fechaInicio,
      fechaTermino,
      observacion: observacion || null
    }
  };
}

app.get('/api/ausencias', autenticar, (req, res) => {
  if (!ausenciasSchemaReady) {
    return res.status(503).json({ error: 'El registro de novedades aún no está listo.' });
  }

  const filtroAtendedor = req.auth.idAtendedor ? 'WHERE ausencia.id_atendedor = ?' : '';
  const parametros = req.auth.idAtendedor ? [req.auth.idAtendedor] : [];
  db.query(`
    SELECT ausencia.id_ausencia AS id,
           ausencia.id_atendedor,
           usuario.nombre AS nombre_atendedor,
           ausencia.tipo,
           DATE_FORMAT(ausencia.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
           DATE_FORMAT(ausencia.fecha_termino, '%Y-%m-%d') AS fecha_termino,
           ausencia.observacion
    FROM ausencia_atendedor ausencia
    INNER JOIN atendedor ON atendedor.id_atendedor = ausencia.id_atendedor
    INNER JOIN usuario ON usuario.id_usuario = atendedor.id_usuario
    ${filtroAtendedor}
    ORDER BY ausencia.fecha_inicio DESC, ausencia.id_ausencia DESC
  `, parametros, (err, rows) => {
    if (err) return res.status(500).json({ error: 'No se pudieron cargar las novedades.' });
    res.json(rows);
  });
});

app.post('/api/ausencias', autenticar, soloAdministrador, (req, res) => {
  if (!ausenciasSchemaReady || !notificacionesSchemaReady) {
    return res.status(503).json({ error: 'El registro de novedades y notificaciones aún no está listo.' });
  }

  const { datos, error } = validarDatosAusencia(req.body || {});
  if (error) return res.status(400).json({ error });

  ejecutarTransaccion(async consultar => {
    const atendedores = await consultar(
      'SELECT id_usuario FROM atendedor WHERE id_atendedor = ? AND activo = 1 FOR UPDATE',
      [datos.idAtendedor]
    );
    if (atendedores.length === 0) {
      return { errorStatus: 404, error: 'Atendedor activo no encontrado.' };
    }
    const solapadas = await consultar(`
      SELECT id_ausencia FROM ausencia_atendedor
      WHERE id_atendedor = ? AND fecha_inicio <= ? AND fecha_termino >= ?
      FOR UPDATE
    `, [datos.idAtendedor, datos.fechaTermino, datos.fechaInicio]);
    if (solapadas.length > 0) {
      return { errorStatus: 409, error: 'El atendedor ya tiene una novedad registrada en ese periodo.' };
    }

    await consultar(`
      INSERT INTO ausencia_atendedor (id_atendedor, tipo, fecha_inicio, fecha_termino, observacion)
      VALUES (?, ?, ?, ?, ?)
    `, [datos.idAtendedor, datos.tipo, datos.fechaInicio, datos.fechaTermino, datos.observacion]);
    const destinatarios = await registrarNotificaciones(
      consultar,
      [atendedores[0].id_usuario],
      'cambio',
      `Tu cuadrante cambió: ${datos.tipo} del ${datos.fechaInicio} al ${datos.fechaTermino}.`
    );
    return { destinatarios };
  }).then(resultado => {
    if (resultado.errorStatus) return res.status(resultado.errorStatus).json({ error: resultado.error });
    resultado.destinatarios.forEach(emitirActualizacionNotificaciones);
    res.status(201).json({ success: true });
  }).catch(err => {
    console.error('Error al registrar una ausencia y notificar al atendedor:', err);
    res.status(500).json({ error: 'No se pudo registrar la novedad ni actualizar su notificación.' });
  });
});

app.put('/api/ausencias/:id', autenticar, soloAdministrador, (req, res) => {
  if (!ausenciasSchemaReady || !notificacionesSchemaReady) {
    return res.status(503).json({ error: 'El registro de novedades y notificaciones aún no está listo.' });
  }

  const idAusencia = Number(req.params.id);
  const { datos, error } = validarDatosAusencia(req.body || {});
  if (!Number.isInteger(idAusencia) || idAusencia <= 0) {
    return res.status(400).json({ error: 'El identificador de la novedad no es válido.' });
  }
  if (error) return res.status(400).json({ error });

  ejecutarTransaccion(async consultar => {
    const inicial = await consultar(
      'SELECT id_atendedor FROM ausencia_atendedor WHERE id_ausencia = ?',
      [idAusencia]
    );
    if (inicial.length === 0) return { errorStatus: 404, error: 'Novedad no encontrada.' };
    const idAtendedorAnterior = Number(inicial[0].id_atendedor);
    const idsAtendedores = [...new Set([idAtendedorAnterior, datos.idAtendedor])].sort((a, b) => a - b);
    const atendedores = await consultar(
      'SELECT id_atendedor, id_usuario, activo FROM atendedor WHERE id_atendedor IN (?) ORDER BY id_atendedor FOR UPDATE',
      [idsAtendedores]
    );
    const atendedorNuevo = atendedores.find(item => Number(item.id_atendedor) === datos.idAtendedor);
    if (!atendedorNuevo || Number(atendedorNuevo.activo) !== 1) {
      return { errorStatus: 404, error: 'Atendedor activo no encontrado.' };
    }
    const actual = await consultar(
      'SELECT id_atendedor FROM ausencia_atendedor WHERE id_ausencia = ? FOR UPDATE',
      [idAusencia]
    );
    if (actual.length === 0) return { errorStatus: 404, error: 'Novedad no encontrada.' };
    if (Number(actual[0].id_atendedor) !== idAtendedorAnterior) {
      return { errorStatus: 409, error: 'La novedad cambió mientras se editaba. Recarga e inténtalo nuevamente.' };
    }

    const solapadas = await consultar(`
      SELECT id_ausencia FROM ausencia_atendedor
      WHERE id_atendedor = ? AND fecha_inicio <= ? AND fecha_termino >= ?
        AND id_ausencia <> ?
      FOR UPDATE
    `, [datos.idAtendedor, datos.fechaTermino, datos.fechaInicio, idAusencia]);
    if (solapadas.length > 0) {
      return { errorStatus: 409, error: 'El atendedor ya tiene otra novedad registrada en ese periodo.' };
    }

    await consultar(`
      UPDATE ausencia_atendedor
      SET id_atendedor = ?, tipo = ?, fecha_inicio = ?, fecha_termino = ?, observacion = ?
      WHERE id_ausencia = ?
    `, [datos.idAtendedor, datos.tipo, datos.fechaInicio, datos.fechaTermino, datos.observacion, idAusencia]);
    const destinatarios = await registrarNotificaciones(
      consultar,
      atendedores.filter(item => Number(item.activo) === 1).map(item => item.id_usuario),
      'cambio',
      `Tu cuadrante cambió por una modificación de ${datos.tipo} (${datos.fechaInicio} al ${datos.fechaTermino}).`
    );
    return { destinatarios };
  }).then(resultado => {
    if (resultado.errorStatus) return res.status(resultado.errorStatus).json({ error: resultado.error });
    resultado.destinatarios.forEach(emitirActualizacionNotificaciones);
    res.json({ success: true });
  }).catch(err => {
    console.error('Error al editar una ausencia y notificar a los atendedores:', err);
    res.status(500).json({ error: 'No se pudo actualizar la novedad ni sus notificaciones.' });
  });
});

app.delete('/api/ausencias/:id', autenticar, soloAdministrador, (req, res) => {
  if (!ausenciasSchemaReady || !notificacionesSchemaReady) {
    return res.status(503).json({ error: 'El registro de novedades y notificaciones aún no está listo.' });
  }
  const idAusencia = Number(req.params.id);
  if (!Number.isInteger(idAusencia) || idAusencia <= 0) {
    return res.status(400).json({ error: 'El identificador de la novedad no es válido.' });
  }

  ejecutarTransaccion(async consultar => {
    const inicial = await consultar(
      'SELECT id_atendedor FROM ausencia_atendedor WHERE id_ausencia = ?',
      [idAusencia]
    );
    if (inicial.length === 0) return { errorStatus: 404, error: 'Novedad no encontrada.' };
    const idAtendedor = Number(inicial[0].id_atendedor);
    const atendedores = await consultar(
      'SELECT id_usuario, activo FROM atendedor WHERE id_atendedor = ? FOR UPDATE',
      [idAtendedor]
    );
    const actual = await consultar(
      'SELECT id_atendedor FROM ausencia_atendedor WHERE id_ausencia = ? FOR UPDATE',
      [idAusencia]
    );
    if (actual.length === 0) return { errorStatus: 404, error: 'Novedad no encontrada.' };
    if (Number(actual[0].id_atendedor) !== idAtendedor) {
      return { errorStatus: 409, error: 'La novedad cambió mientras se eliminaba. Recarga e inténtalo nuevamente.' };
    }
    await consultar('DELETE FROM ausencia_atendedor WHERE id_ausencia = ?', [idAusencia]);
    const destinatarios = await registrarNotificaciones(
      consultar,
      atendedores.length > 0 && Number(atendedores[0].activo) === 1 ? [atendedores[0].id_usuario] : [],
      'cambio',
      'Se eliminó una novedad que afectaba tu cuadrante; revisa tus turnos.'
    );
    return { destinatarios };
  }).then(resultado => {
    if (resultado.errorStatus) return res.status(resultado.errorStatus).json({ error: resultado.error });
    resultado.destinatarios.forEach(emitirActualizacionNotificaciones);
    res.json({ success: true });
  }).catch(err => {
    console.error('Error al eliminar una ausencia y notificar al atendedor:', err);
    res.status(500).json({ error: 'No se pudo eliminar la novedad ni actualizar su notificación.' });
  });
});

// 3. ACTUALIZAR LICENCIA (PUT)
app.put('/api/empleados/:id/licencia', autenticar, soloAdministrador, (req, res) => {
  const id = Number(req.params.id);
  const { licencia } = req.body;
  if (!Number.isInteger(id) || id <= 0 || typeof licencia !== 'boolean') {
    return res.status(400).json({ error: 'El estado de licencia no es válido.' });
  }
  if (!notificacionesSchemaReady) {
    return res.status(503).json({ error: 'Las notificaciones aún no están listas.' });
  }

  ejecutarTransaccion(async consultar => {
    const atendedores = await consultar(
      'SELECT id_usuario, activo, posee_licencia_medica FROM atendedor WHERE id_atendedor = ? FOR UPDATE',
      [id]
    );
    if (atendedores.length === 0) {
      return { errorStatus: 404, error: 'Atendedor no encontrado.' };
    }
    if (Boolean(atendedores[0].posee_licencia_medica) === licencia) {
      return { destinatarios: [] };
    }

    await consultar(
      'UPDATE atendedor SET posee_licencia_medica = ? WHERE id_atendedor = ?',
      [licencia ? 1 : 0, id]
    );
    const destinatarios = await registrarNotificaciones(
      consultar,
      Number(atendedores[0].activo) === 1 ? [atendedores[0].id_usuario] : [],
      'cambio',
      licencia
        ? 'Se registró una licencia sin fechas que modifica tu disponibilidad en el cuadrante.'
        : 'Se retiró una licencia sin fechas; revisa tu cuadrante.'
    );
    return { destinatarios };
  }).then(resultado => {
    if (resultado.errorStatus) return res.status(resultado.errorStatus).json({ error: resultado.error });
    resultado.destinatarios.forEach(emitirActualizacionNotificaciones);
    res.json({ success: true });
  }).catch(err => {
    console.error('Error al actualizar una licencia y notificar al atendedor:', err);
    res.status(500).json({ error: 'No se pudo actualizar la licencia ni su notificación.' });
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
                      adm.id_administrador = (SELECT MIN(id_administrador) FROM administrador) AS es_general,
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
    ejecutarTransaccion(async consultar => {
      const resultadoUsuario = await consultar(
        'INSERT INTO usuario (rut, hash_contrasena, email, nombre, debe_cambiar_contrasena) VALUES (?, ?, ?, ?, 0)',
        [rut, passwordHash, email, nombre]
      );
      await consultar(
        'INSERT INTO administrador (departamento, id_usuario) VALUES (?, ?)',
        [departamento, resultadoUsuario.insertId]
      );
    }).then(() => {
      res.json({ success: true, message: 'Administrador creado correctamente' });
    }).catch(err => {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: 'El correo electrónico o RUT ya se encuentran registrados.' });
      }
      console.error('Error al crear el usuario y el administrador:', err);
      res.status(500).json({ error: 'No se pudo crear el usuario y el administrador.' });
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

  db.query(`
    SELECT activo,
           id_administrador = (SELECT MIN(id_administrador) FROM administrador) AS es_general
    FROM administrador
    WHERE id_administrador = ?
  `, [req.params.id], (errFind, rows) => {
    if (errFind) return res.status(500).json({ error: 'No se pudo validar el administrador.' });
    if (rows.length === 0) return res.status(404).json({ error: 'Administrador no encontrado.' });
    if (Boolean(rows[0].activo) === activo) return res.json({ success: true });
    if (!activo && Boolean(rows[0].es_general)) {
      return res.status(409).json({ error: 'La cuenta del administrador general no se puede archivar.' });
    }

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
  if (!['Dia libre', 'Vacaciones', 'Licencia'].includes(tipo) ||
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
    if (!ausenciasSchemaReady || !notificacionesSchemaReady) {
      return res.status(503).json({ error: 'Las ausencias y notificaciones aún no están listas.' });
    }

    const idSolicitud = Number(req.params.id);
    if (!Number.isInteger(idSolicitud) || idSolicitud <= 0) {
      return res.status(400).json({ error: 'El identificador de la solicitud no es válido.' });
    }

    ejecutarTransaccion(async consultar => {
      const solicitudesPendientes = await consultar(`
        SELECT s.id_solicitud, s.id_atendedor, s.tipo_solicitud,
               DATE_FORMAT(s.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
               DATE_FORMAT(s.fecha_termino, '%Y-%m-%d') AS fecha_termino,
               a.activo, a.id_usuario
        FROM solicituddialibre s
        INNER JOIN atendedor a ON a.id_atendedor = s.id_atendedor
        WHERE s.id_solicitud = ? AND s.estado_solicitud = 'Pendiente'
        FOR UPDATE
      `, [idSolicitud]);
      if (solicitudesPendientes.length === 0) {
        return { errorStatus: 404, error: 'Solicitud pendiente no encontrada.' };
      }

      const solicitud = solicitudesPendientes[0];
      if (Number(solicitud.activo) !== 1) {
        return { errorStatus: 409, error: 'No se puede aprobar una solicitud de un atendedor inactivo.' };
      }

      if (estado === 'Aprobada') {
        await consultar(
          'SELECT id_atendedor FROM atendedor WHERE id_atendedor = ? FOR UPDATE',
          [solicitud.id_atendedor]
        );
        const ausenciasSolapadas = await consultar(`
          SELECT id_ausencia
          FROM ausencia_atendedor
          WHERE id_atendedor = ? AND fecha_inicio <= ? AND fecha_termino >= ?
          FOR UPDATE
        `, [solicitud.id_atendedor, solicitud.fecha_termino, solicitud.fecha_inicio]);
        if (ausenciasSolapadas.length > 0) {
          return {
            errorStatus: 409,
            error: 'El periodo solicitado se cruza con una licencia o ausencia ya registrada.'
          };
        }

        const tipoAusencia = solicitud.tipo_solicitud === 'Dia libre'
          ? 'dia_libre'
          : solicitud.tipo_solicitud === 'Vacaciones'
            ? 'vacaciones'
            : 'licencia_medica';
        await consultar(`
          INSERT INTO ausencia_atendedor (id_atendedor, tipo, fecha_inicio, fecha_termino, observacion)
          VALUES (?, ?, ?, ?, ?)
        `, [
          solicitud.id_atendedor,
          tipoAusencia,
          solicitud.fecha_inicio,
          solicitud.fecha_termino,
          `Solicitud aprobada #${idSolicitud}`
        ]);
      }

      await consultar(`
        UPDATE solicituddialibre
        SET estado_solicitud = ?, id_administrador = ?
        WHERE id_solicitud = ? AND estado_solicitud = 'Pendiente'
      `, [estado, req.auth.idAdministrador, idSolicitud]);
      const mensaje = estado === 'Aprobada'
        ? `Tu solicitud (${solicitud.fecha_inicio} al ${solicitud.fecha_termino}) fue aprobada y se aplicó a tu calendario.`
        : `Tu solicitud (${solicitud.fecha_inicio} al ${solicitud.fecha_termino}) fue rechazada.`;
      const destinatarios = await registrarNotificaciones(
        consultar,
        [solicitud.id_usuario],
        'cambio',
        mensaje
      );
      return { idUsuario: destinatarios[0] };
    }).then(resultado => {
      if (resultado.errorStatus) {
        return res.status(resultado.errorStatus).json({ error: resultado.error });
      }
      emitirActualizacionNotificaciones(resultado.idUsuario);
      res.json({ success: true });
    }).catch(err => {
      console.error('Error al resolver una solicitud de días libres:', err);
      res.status(500).json({ error: 'No se pudo responder la solicitud ni actualizar el calendario.' });
    });
    return;
  }

  const { tipo, fecha_inicio, fecha_fin, motivo } = req.body;
  const motivoLimpio = typeof motivo === 'string' ? motivo.trim() : '';
  if (!['Dia libre', 'Vacaciones', 'Licencia'].includes(tipo) ||
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
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'El identificador del administrador no es válido.' });
  }
  if (id === Number(req.auth.idAdministrador)) {
    return res.status(409).json({ error: 'No puedes archivar tu propia cuenta de administrador.' });
  }

  db.query(`
    SELECT activo,
           id_administrador = (SELECT MIN(id_administrador) FROM administrador) AS es_general
    FROM administrador
    WHERE id_administrador = ?
  `, [id], (errFind, rows) => {
    if (errFind) return res.status(500).json({ error: 'No se pudo validar el administrador.' });
    if (rows.length === 0 || !rows[0].activo) return res.status(404).json({ error: 'Administrador activo no encontrado.' });
    if (Boolean(rows[0].es_general)) {
      return res.status(409).json({ error: 'La cuenta del administrador general no se puede archivar.' });
    }
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
  res.sendFile(path.join(publicDirectory, 'index.html'));
});

app.listen(3000, () => {
  console.log('Servidor corriendo en http://localhost:3000');
});