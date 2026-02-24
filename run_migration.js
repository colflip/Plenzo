require('dotenv').config();
const runMigrations = require('./src/server/db/migrations');
runMigrations().then(() => {
    console.log('Done');
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
