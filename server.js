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

db.connect(err => {
  if (err) {
    console.error('Error al conectar a MariaDB:', err);
  } else {
    console.log('Conectado exitosamente a la base de datos gestion_turnos_copec en XAMPP');
  }
});

// 0. AUTENTICACIÓN / LOGIN
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Ingresa correo y contraseña' });

  const sql = `
    SELECT u.id_usuario, u.rut, u.nombre, u.email,
           adm.id_administrador, at.id_atendedor
    FROM usuario u
    LEFT JOIN administrador adm ON u.id_usuario = adm.id_usuario
    LEFT JOIN atendedor at ON u.id_usuario = at.id_usuario
    WHERE u.email = ? AND u.hash_contrasena = ?
  `;

  db.query(sql, [email, password], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });

    if (results.length > 0) {
      const user = results[0];
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
    } else {
      res.status(401).json({ success: false, error: 'Correo o contraseña incorrectos' });
    }
  });
});

// 1. Obtener empleados (GET)
app.get('/api/empleados', (req, res) => {
  const sql = `SELECT a.id_atendedor AS id, u.rut, u.nombre AS nombre, u.email, a.posee_licencia_medica AS licencia 
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

// 2. Guardar nuevo atendedor (POST)
app.post('/api/empleados', (req, res) => {
  const { rut, nombre } = req.body;
  if (!rut || !nombre) return res.status(400).json({ error: 'Faltan datos obligatorios' });

  const nombreFormateado = nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, '.');

  const emailNombreApellido = `${nombreFormateado}@copec.cl`;
  const passDefault = '123456';

  const sqlUser = `INSERT INTO usuario (rut, hash_contrasena, email, nombre) VALUES (?, ?, ?, ?)`;

  db.query(sqlUser, [rut, passDefault, emailNombreApellido, nombre], (err, resultUser) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        const emailConNumero = `${nombreFormateado}.${Date.now().toString().slice(-3)}@copec.cl`;
        return db.query(sqlUser, [rut, passDefault, emailConNumero, nombre], (err2, resultUser2) => {
          if (err2) return res.status(500).json({ error: 'Error al insertar usuario: ' + err2.message });
          insertarAtendedor(resultUser2.insertId, emailConNumero, res);
        });
      }
      return res.status(500).json({ error: 'Error al insertar usuario: ' + err.message });
    }

    insertarAtendedor(resultUser.insertId, emailNombreApellido, res);
  });
});

function insertarAtendedor(idUsuario, emailCreado, res) {
  const fechaHoy = new Date().toISOString().slice(0, 10);
  const sqlAtendedor = `INSERT INTO atendedor (fecha_contratacion, posee_licencia_medica, id_usuario) VALUES (?, FALSE, ?)`;

  db.query(sqlAtendedor, [fechaHoy, idUsuario], (err, resultAtendedor) => {
    if (err) return res.status(500).json({ error: 'Error al insertar atendedor: ' + err.message });
    
    res.json({ 
      success: true, 
      id: resultAtendedor.insertId,
      emailCreado: emailCreado 
    });
  });
}

// 3. Actualizar Licencia (PUT)
app.put('/api/empleados/:id/licencia', (req, res) => {
  const { id } = req.params;
  const { licencia } = req.body;

  const sql = `UPDATE atendedor SET posee_licencia_medica = ? WHERE id_atendedor = ?`;

  db.query(sql, [licencia ? 1 : 0, id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Error al actualizar licencia: ' + err.message });
    res.json({ success: true });
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(3000, () => {
  console.log('Servidor corriendo en http://localhost:3000');
});