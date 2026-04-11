const mongoose = require('mongoose');

const adminSchema = new mongoose.Schema({
    username: String,
    password: String // Store hashed password for security
});

const Admin = mongoose.model('Admin', adminSchema);

module.exports = Admin;
