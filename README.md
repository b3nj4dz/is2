### 🚀 Instalación y Ejecución Rápida

```bash
# 1. Instalar dependencias del proyecto
npm install express mysql2 cors

# 2. Iniciar el servidor backend
node server.js

# 3. Abrir en el navegador
http://localhost:3000

# 4. Acceso
Utiliza una cuenta existente en la base de datos. Las nuevas cuentas requieren una
contraseña de 8 a 128 caracteres con mayúscula, minúscula, número y símbolo.
Las contraseñas se almacenan protegidas con scrypt; el servidor migra las claves
en texto plano existentes al iniciar y exige cambiarlas si no cumplen la política
de seguridad.

Las rutas privadas requieren una sesión emitida al iniciar sesión, válida por
8 horas. Los permisos se verifican en el servidor: los administradores gestionan
personal, asistencia y solicitudes; cada atendedor solo consulta su propia ficha
y sus solicitudes.

Los turnos semanales se guardan en la tabla `asignacionsemanal`; el servidor la
crea al iniciar si aún no existe. Los horarios iniciales se guardan al cargar el
cuadrante como administrador, y los cambios manuales y la generación automática
se guardan al aplicarse.

El personal y los administradores se pueden editar y archivar/reactivar sin
eliminar sus referencias históricas. Las solicitudes pendientes se pueden editar
o cancelar, y los registros de asistencia se pueden corregir o anular; los
registros anulados se conservan visibles en el historial.

