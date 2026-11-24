import mysql from 'mysql2/promise';

// ======================================================
// MYSQL (XAMPP) CONNECTION
// ======================================================
// XAMPP's default MySQL account is "root" with an empty password.
// 127.0.0.1 is used instead of "localhost" because on Windows Node may
// resolve "localhost" to IPv6 (::1), which XAMPP's MySQL does not listen on.
//
// Change DB_NAME (or set the environment variable) to the name of the
// database you created in phpMyAdmin.

export const DB_CONFIG = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'unklab_library'
};

export const pool = mysql.createPool({
    ...DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 10,
    // Store and read DATETIME values as UTC so they match the
    // ISO strings (toISOString) the app used with the JSON files.
    timezone: 'Z',
    charset: 'utf8mb4'
});

// Run a query and return only the rows.
export async function query(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows;
}

// Run several queries in one transaction.
// Usage: await withTransaction(async conn => { await conn.execute(...); });
export async function withTransaction(work) {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

// ======================================================
// STARTUP CHECK
// ======================================================
// Confirms the database is reachable and that the four tables have the
// columns this code uses. Prints a clear message instead of failing
// later with a confusing SQL error.

const REQUIRED_COLUMNS = {
    data: ['username', 'password', 'status', 'enableLogin'],
    referenceBookData: ['title', 'author', 'status', 'bookDescription'],
    borrowedBook: [
        'title', 'author', 'status', 'bookDescription', 'username', 'borrowedAt'
    ],
    donateBook: [
        'id', 'title', 'author', 'status', 'bookDescription',
        'donatedBy', 'donatedAt', 'reviewStatus', 'reviewedBy', 'reviewedAt'
    ]
};

// Data type of data.enableLogin ("varchar", "tinyint", ...), filled in by
// checkDatabase(). Lets the code write a value the column accepts.
export let enableLoginType = 'varchar';

export async function checkDatabase() {
    const rows = await query(
        `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, DATA_TYPE AS dataType
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?`,
        [DB_CONFIG.database]
    );

    const found = {};

    for (const row of rows) {
        const table = row.tableName.toLowerCase();
        found[table] ??= {};
        found[table][row.columnName.toLowerCase()] = row.dataType.toLowerCase();
    }

    const problems = [];

    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
        if (!found[table.toLowerCase()]) {
            problems.push(`Table "${table}" was not found.`);
            continue;
        }

        const missing = columns.filter(
            column => !(column.toLowerCase() in found[table.toLowerCase()])
        );

        if (missing.length) {
            problems.push(
                `Table "${table}" is missing column(s): ${missing.join(', ')}`
            );
        }
    }

    if (found.data?.enablelogin) {
        enableLoginType = found.data.enablelogin;
    }

    return problems;
}
