import bcrypt from 'bcryptjs';

const password = 'Agent@2026!';
const hash = await bcrypt.hash(password, 12);
console.log('Hash:', hash);