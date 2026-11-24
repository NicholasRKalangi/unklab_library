
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import nodemailer from 'nodemailer';
import { serveStatic } from './utils/serveStatic.js';
import { handleNews } from './handlers/routeHandlers.js';
import {
    pool,
    query,
    withTransaction,
    checkDatabase,
    DB_CONFIG,
    enableLoginType
} from './db.js';

// ======================================================
// SERVER
// ======================================================
// All data now lives in the MySQL (XAMPP) tables:
// data (accounts), referenceBookData (books), borrowedBook, donateBook.

const PORT = 8007;
const __dirname = import.meta.dirname;

// ======================================================
// EMAIL
// ======================================================

const EMAIL_USER = process.env.EMAIL_USER || 's22310290@student.unklab.ac.id';
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || 'impokxwnxqxofxgo';

const emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASSWORD
    }
});

// ======================================================
// SESSIONS
// ======================================================

const sessions = new Map();
const SESSION_DURATION = 2 * 60 * 60 * 1000;

function createSession(user) {
    const sessionId = crypto.randomBytes(32).toString('hex');

    sessions.set(sessionId, {
        username: user.username,
        status: user.status,
        expiresAt: Date.now() + SESSION_DURATION
    });

    return sessionId;
}

function getSessionId(req) {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;

    const cookie = cookieHeader
        .split(';')
        .map(item => item.trim())
        .find(item => item.startsWith('sessionId='));

    if (!cookie) return null;

    try {
        return decodeURIComponent(cookie.substring('sessionId='.length));
    } catch {
        return null;
    }
}

async function getSessionUser(req) {
    const sessionId = getSessionId(req);
    if (!sessionId) return null;

    const session = sessions.get(sessionId);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
        sessions.delete(sessionId);
        return null;
    }

    // Recheck the account against the data table on every request.
    // Disabling an account therefore invalidates its existing session.
    try {
        const currentUser = await findUser(session.username);

        if (
            !currentUser ||
            !isLoginEnabled(currentUser.enableLogin) ||
            currentUser.status !== session.status
        ) {
            sessions.delete(sessionId);
            return null;
        }
    } catch {
        sessions.delete(sessionId);
        return null;
    }

    return session;
}

// Accepts "True"/"true" (VARCHAR column) as well as 1/true
// (TINYINT / BOOLEAN column).
function isLoginEnabled(value) {
    return (
        value === 'True' ||
        value === 'true' ||
        value === '1' ||
        value === 1 ||
        value === true
    );
}

// The value to store in data.enableLogin, matching the column's type.
function enableLoginValue(enabled) {
    const textType = ['varchar', 'char', 'text', 'tinytext', 'enum'];

    if (textType.includes(enableLoginType)) {
        return enabled ? 'True' : 'False';
    }

    return enabled ? 1 : 0;
}

// Return enableLogin to the frontend as "True"/"False" like before.
function enableLoginText(value) {
    return isLoginEnabled(value) ? 'True' : 'False';
}

function redirectToLogin(res) {
    res.writeHead(302, {
        Location: '/html/login.html',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache'
    });
    res.end();
}

function sendAccessDenied(res) {
    res.writeHead(403, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
    });

    res.end(`
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="UTF-8"><title>Access Denied</title></head>
        <body>
            <h1>403 - Access Denied</h1>
            <p>You do not have permission to access this page.</p>
            <a href="/html/login.html">Go to Login</a>
        </body>
        </html>
    `);
}

async function requireLogin(req, res) {
    const user = await getSessionUser(req);

    if (!user) {
        redirectToLogin(res);
        return null;
    }

    return user;
}

async function checkProtectedPage(req, res) {
    const requestURL = new URL(
        req.url,
        `http://${req.headers.host || 'localhost'}`
    );

    const pathname = requestURL.pathname;

    if (
        pathname.startsWith('/html/user/') ||
        pathname.startsWith('/html/staff/') ||
        pathname.startsWith('/html/admin/')
    ) {
        const user = await requireLogin(req, res);
        if (!user) return false;

        if (pathname.startsWith('/html/user/')) {
            if (user.status !== 'user') {
                sendAccessDenied(res);
                return false;
            }
        }

        if (pathname.startsWith('/html/staff/')) {
            if (user.status !== 'staff' && user.status !== 'admin') {
                sendAccessDenied(res);
                return false;
            }
        }

        if (pathname.startsWith('/html/admin/')) {
            if (user.status !== 'admin') {
                sendAccessDenied(res);
                return false;
            }
        }
    }

    return true;
}

// ======================================================
// DATABASE HELPERS
// ======================================================

async function findUser(username) {
    const rows = await query(
        'SELECT username, password, status, enableLogin FROM data WHERE username = ? LIMIT 1',
        [username]
    );

    return rows[0] || null;
}

const BOOK_COLUMNS = 'title, author, status, bookDescription';

const BORROWED_COLUMNS =
    'title, author, status, bookDescription, username, borrowedAt';

const DONATION_COLUMNS =
    'id, title, author, status, bookDescription, donatedBy, donatedAt, ' +
    'reviewStatus, reviewedBy, reviewedAt';

// Accepts a Date, an ISO string or a MySQL DATETIME string and returns
// a Date so it can be compared/stored consistently.
function toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

// The current time without milliseconds. borrowedBook.borrowedAt is a
// DATETIME (whole seconds) and part of the primary key, so the value kept
// in memory must be exactly the value stored in MySQL.
function nowWholeSeconds() {
    return new Date(Math.floor(Date.now() / 1000) * 1000);
}

// borrowedBook has no email column, so the email is worked out from the
// username, the same way the borrow form always did.
function studentEmail(username) {
    return `${username}@student.unklab.ac.id`;
}

function withEmail(record) {
    return { ...record, email: studentEmail(record.username) };
}

// ======================================================
// LOAN PERIODS / RETURN DATES
// ======================================================
// Same rules the chatbot tells students:
//   white room   -> 3 days
//   science room -> 1 week
// Any other borrowable room also gets 1 week.
// (Reference room books cannot be borrowed at all.)

const DAY_MS = 24 * 60 * 60 * 1000;

function loanDays(status) {
    const room = String(status || '').toLowerCase();
    if (room.includes('white')) return 3;
    if (room.includes('science')) return 7;
    return 7;
}

function dueDate(record) {
    const borrowedAt = toDate(record.borrowedAt);
    if (!borrowedAt) return null;
    return new Date(borrowedAt.getTime() + loanDays(record.status) * DAY_MS);
}

// A borrowed-book row with its email, return date and loan length added.
function withLoanInfo(record) {
    return {
        ...withEmail(record),
        loanDays: loanDays(record.status),
        dueAt: dueDate(record)
    };
}

// ======================================================
// BORROW HISTORY (for the "frequently borrowed" dashboard)
// ======================================================
// borrowedBook only holds books that are out right now (the row is deleted
// on return), so it cannot tell how often a book was borrowed. Every loan
// is therefore also written to borrowHistory, which is never deleted from.
// The table is created automatically on startup.

async function ensureBorrowHistoryTable() {
    await query(`
        CREATE TABLE IF NOT EXISTS borrowHistory (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(191) NOT NULL,
            author VARCHAR(191) NOT NULL,
            status VARCHAR(255),
            username VARCHAR(191) NOT NULL,
            borrowedAt DATETIME NOT NULL,
            returnedAt DATETIME NULL,

            UNIQUE KEY loan (title, author, username, borrowedAt),
            KEY borrowedAtIndex (borrowedAt)
        ) ENGINE=InnoDB
    `);

    // Books that were already out before this table existed still count.
    await query(`
        INSERT IGNORE INTO borrowHistory (title, author, status, username, borrowedAt)
        SELECT title, author, status, username, borrowedAt FROM borrowedBook
    `);
}

// Makes sure borrowHistory exists before it is used. If MySQL was not
// running when the server started, the table is created the first time
// it is needed instead. After it succeeds once, it is not run again.
let borrowHistoryReady = null;

function readyBorrowHistory() {
    if (!borrowHistoryReady) {
        borrowHistoryReady = ensureBorrowHistoryTable().catch(error => {
            borrowHistoryReady = null; // try again on the next request
            throw error;
        });
    }
    return borrowHistoryReady;
}

function isDuplicateKey(error) {
    return error && error.code === 'ER_DUP_ENTRY';
}

function sendJSON(res, statusCode, data) {
    if (res.writableEnded) return;

    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache'
    });

    res.end(JSON.stringify(data));
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();

            if (body.length > 1_000_000) {
                reject(new Error('Request body is too large.'));
                req.destroy();
            }
        });

        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error('Invalid JSON request body.'));
            }
        });

        req.on('error', reject);
    });
}

async function requireApiLogin(req, res) {
    const user = await getSessionUser(req);

    if (!user) {
        sendJSON(res, 401, { error: 'You must be logged in.' });
        return null;
    }

    return user;
}

async function requireApiRole(req, res, allowedRoles) {
    const user = await requireApiLogin(req, res);
    if (!user) return null;

    if (!allowedRoles.includes(user.status)) {
        sendJSON(res, 403, {
            error: 'You do not have permission to perform this action.'
        });
        return null;
    }

    return user;
}

// ======================================================
// EMAIL NOTIFICATION
// ======================================================

async function sendLateReturnEmail(email, book) {
    try {
        await emailTransporter.sendMail({
            from: EMAIL_USER,
            to: email,
            subject: 'Unklab Library - Late Book Return Notification',
            text: `Hello,

This is a notification from Unklab Library.

The following book has not been returned yet:
Title: ${book.title}
Author: ${book.author}

You are late to return this book. Please return it to Unklab Library as soon as possible.

Thank you.
Unklab Library`
        });

        console.log(`Late return email sent to ${email}`);
    } catch (error) {
        console.error(`Could not send email to ${email}:`, error);
    }
}

// ======================================================
// PYTHON AI CHATBOT
// ======================================================

const pythonExecutable =
    process.env.PYTHON_PATH || 'python';

// The chatbot reads the "referenceBookData" table directly, so it gets the same
// MySQL settings as this server.
const python = spawn(pythonExecutable, ['main.py'], {
    cwd: __dirname,
    env: {
        ...process.env,
        DB_HOST: DB_CONFIG.host,
        DB_PORT: String(DB_CONFIG.port),
        DB_USER: DB_CONFIG.user,
        DB_PASSWORD: DB_CONFIG.password,
        DB_NAME: DB_CONFIG.database
    }
});

python.on('error', error => {
    console.error('Could not start Python:', error);
});

python.stderr.on('data', data => {
    console.error(`Python: ${data}`);
});

let aiOutputBuffer = '';
let aiQueue = Promise.resolve();

function askAI(question) {
    const request = aiQueue.then(() => new Promise((resolve, reject) => {
        if (!python.stdin.writable) {
            reject(new Error('Python AI process is not available.'));
            return;
        }

        let output = '';

        function onData(data) {
            output += data.toString();

            const newlineIndex = output.indexOf('\n');
            if (newlineIndex === -1) return;

            python.stdout.off('data', onData);

            const line = output.slice(0, newlineIndex);
            aiOutputBuffer = output.slice(newlineIndex + 1);

            try {
                const result = JSON.parse(line);

                if (result.error) {
                    reject(new Error(result.error));
                } else {
                    resolve(result.answer);
                }
            } catch (error) {
                reject(error);
            }
        }

        python.stdout.on('data', onData);

        if (aiOutputBuffer) {
            const saved = aiOutputBuffer;
            aiOutputBuffer = '';
            onData(Buffer.from(saved));
        }

        python.stdin.write(JSON.stringify({ question }) + '\n');
    }));

    aiQueue = request.catch(() => {});
    return request;
}

// ======================================================
// HTTP SERVER
// ======================================================

const server = http.createServer(async (req, res) => {
    const requestURL = new URL(
        req.url,
        `http://${req.headers.host || 'localhost'}`
    );

    const pathname = requestURL.pathname;

    console.log(`${req.method} ${pathname}`);

    try {

        // ==============================================
        // LOGIN
        // ==============================================

        if (pathname === '/login' && req.method === 'POST') {
            let body = '';

            req.on('data', chunk => {
                body += chunk.toString();
            });

            req.on('end', async () => {
                try {
                    const formData = new URLSearchParams(body);
                    const username = formData.get('username') || '';
                    const password = formData.get('password') || '';

                    const found = await findUser(username);

                    // Compare in JavaScript so the check stays
                    // case-sensitive regardless of the table collation.
                    const user =
                        found &&
                        found.username === username &&
                        found.password === password
                            ? found
                            : null;

                    if (!user) {
                        res.writeHead(401, {
                            'Content-Type': 'text/html; charset=utf-8',
                            'Cache-Control': 'no-store'
                        });

                        res.end(`
                            <!DOCTYPE html>
                            <html lang="en">
                            <head><meta charset="UTF-8"><title>Login Failed</title></head>
                            <body>
                                <h1>Login failed</h1>
                                <p>Incorrect username or password.</p>
                                <a href="/html/login.html">Try again</a>
                            </body>
                            </html>
                        `);
                        return;
                    }

                    // NEW: Check enableLogin before creating a session.
                    if (!isLoginEnabled(user.enableLogin)) {
                        res.writeHead(403, {
                            'Content-Type': 'text/html; charset=utf-8',
                            'Cache-Control': 'no-store'
                        });

                        res.end(`
                            <!DOCTYPE html>
                            <html lang="en">
                            <head><meta charset="UTF-8"><title>Login Disabled</title></head>
                            <body>
                                <h1>Login disabled</h1>
                                <p>Your account has been disabled. Please contact an administrator.</p>
                                <a href="/html/login.html">Back to Login</a>
                            </body>
                            </html>
                        `);
                        return;
                    }

                    let redirectPath;

                    if (user.status === 'user') {
                        redirectPath = '/html/user/index.html';
                    } else if (user.status === 'staff') {
                        redirectPath = '/html/staff/index.html';
                    } else if (user.status === 'admin') {
                        redirectPath = '/html/admin/index.html';
                    } else {
                        res.writeHead(403, {
                            'Content-Type': 'text/html; charset=utf-8'
                        });
                        res.end('<h1>Invalid account status</h1>');
                        return;
                    }

                    const sessionId = createSession(user);
                    const cookie =
                        `sessionId=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; Max-Age=7200; SameSite=Lax`;

                    res.writeHead(302, {
                        Location: redirectPath,
                        'Set-Cookie': cookie,
                        'Cache-Control': 'no-store'
                    });

                    res.end();
                } catch (error) {
                    console.error('Login error:', error);

                    res.writeHead(500, {
                        'Content-Type': 'text/html; charset=utf-8'
                    });

                    res.end('<h1>Server Error</h1>');
                }
            });

            return;
        }

        // ==============================================
        // ADMIN: GET ACCOUNTS
        // ==============================================

        if (pathname === '/api/admin/accounts' && req.method === 'GET') {
            const admin = await requireApiRole(req, res, ['admin']);
            if (!admin) return;

            const users = await query(
                'SELECT username, status, enableLogin FROM data ORDER BY username'
            );

            // Do not return passwords or accounts with admin in their status.
            const accounts = users
                .filter(user =>
                    typeof user.status === 'string' &&
                    !user.status.toLowerCase().includes('admin') &&
                    user.username !== admin.username
                )
                .map(user => ({
                    username: user.username,
                    status: user.status,
                    enableLogin: enableLoginText(user.enableLogin)
                }));

            sendJSON(res, 200, accounts);
            return;
        }

        // ==============================================
        // ADMIN: ENABLE / DISABLE ACCOUNT LOGIN
        // ==============================================

        const accountMatch = pathname.match(
            /^\/api\/admin\/accounts\/([^/]+)\/(enable|disable)$/
        );

        if (accountMatch && req.method === 'POST') {
            const admin = await requireApiRole(req, res, ['admin']);
            if (!admin) return;

            const username = decodeURIComponent(accountMatch[1]);
            const action = accountMatch[2];

            const target = await findUser(username);

            if (
                !target ||
                typeof target.status !== 'string' ||
                target.status.toLowerCase().includes('admin') ||
                target.username === admin.username
            ) {
                sendJSON(res, 404, {
                    error: 'Account not found or cannot be managed.'
                });
                return;
            }

            await query(
                'UPDATE data SET enableLogin = ? WHERE username = ?',
                [enableLoginValue(action === 'enable'), target.username]
            );

            // Immediately invalidate any active sessions for this account.
            if (action === 'disable') {
                for (const [sessionId, session] of sessions.entries()) {
                    if (session.username === target.username) {
                        sessions.delete(sessionId);
                    }
                }
            }

            sendJSON(res, 200, {
                message: `Login ${action === 'enable' ? 'enabled' : 'disabled'} for ${target.username}.`,
                username: target.username,
                enableLogin: action === 'enable' ? 'True' : 'False'
            });

            return;
        }

        // ==============================================
        // CHATBOT
        // ==============================================

        if (pathname === '/api/chat' && req.method === 'POST') {
            const user = await requireApiLogin(req, res);
            if (!user) return;

            const data = await readRequestBody(req);
            const question = data.question;

            if (typeof question !== 'string' || !question.trim()) {
                sendJSON(res, 400, { error: 'Question cannot be empty.' });
                return;
            }

            try {
                const answer = await askAI(question);
                sendJSON(res, 200, { answer });
            } catch (error) {
                console.error('AI chatbot error:', error);
                sendJSON(res, 500, { error: 'AI chatbot error.' });
            }

            return;
        }

        // ==============================================
        // GET / SEARCH BOOKS
        // ==============================================

        if (pathname === '/api/books' && req.method === 'GET') {
            const user = await requireApiLogin(req, res);
            if (!user) return;

            const search = (requestURL.searchParams.get('search') || '').trim();
            const like = `%${search}%`;

            const availableBooks = await query(
                `SELECT ${BOOK_COLUMNS} FROM referenceBookData
                 WHERE title LIKE ? OR author LIKE ? OR status LIKE ? OR bookDescription LIKE ?
                 ORDER BY title, author`,
                [like, like, like, like]
            );

            // Borrowed books are listed too. Searching "borrowed" lists
            // every borrowed book.
            const borrowedBooks = await query(
                `SELECT ${BORROWED_COLUMNS} FROM borrowedBook
                 WHERE title LIKE ? OR author LIKE ? OR status LIKE ? OR bookDescription LIKE ?
                    OR 'borrowed' LIKE ?
                 ORDER BY title, author, borrowedAt`,
                [like, like, like, like, like]
            );

            const books = [
                ...availableBooks.map(book => ({ ...book, borrowed: false })),
                // The borrower's name/email is not sent here: students
                // can search too. Staff see it in "Books currently borrowed".
                ...borrowedBooks.map(book => ({
                    title: book.title,
                    author: book.author,
                    status: book.status,
                    bookDescription: book.bookDescription,
                    borrowed: true,
                    borrowedAt: book.borrowedAt,
                    dueAt: dueDate(book)
                }))
            ].sort((a, b) =>
                String(a.title).localeCompare(String(b.title)) ||
                String(a.author).localeCompare(String(b.author)) ||
                Number(a.borrowed) - Number(b.borrowed)
            );

            sendJSON(res, 200, books);
            return;
        }

        // ==============================================
        // ADD BOOK
        // ==============================================

        if (pathname === '/api/books' && req.method === 'POST') {
            const user = await requireApiRole(req, res, ['staff', 'admin']);
            if (!user) return;

            const data = await readRequestBody(req);

            const title = data.title?.trim();
            const author = data.author?.trim();
            const status = data.status?.trim();
            const bookDescription = data.bookDescription?.trim();

            if (!title || !author || !status || !bookDescription) {
                sendJSON(res, 400, { error: 'All book fields are required.' });
                return;
            }

            try {
                await query(
                    'INSERT INTO referenceBookData (title, author, status, bookDescription) VALUES (?, ?, ?, ?)',
                    [title, author, status, bookDescription]
                );
            } catch (error) {
                // (title, author) is the primary key of referenceBookData.
                if (isDuplicateKey(error)) {
                    sendJSON(res, 409, {
                        error: 'A book with this title and author is already in the library.'
                    });
                    return;
                }
                throw error;
            }

            sendJSON(res, 201, {
                message: 'Book added successfully.',
                book: { title, author, status, bookDescription }
            });

            return;
        }

        // ==============================================
        // DELETE BOOK
        // ==============================================

        if (pathname === '/api/books' && req.method === 'DELETE') {
            const user = await requireApiRole(req, res, ['staff', 'admin']);
            if (!user) return;

            const bookToDelete = await readRequestBody(req);

            // title + author is the primary key, so it identifies one book.
            const result = await query(
                'DELETE FROM referenceBookData WHERE title = ? AND author = ?',
                [bookToDelete.title ?? '', bookToDelete.author ?? '']
            );

            if (result.affectedRows === 0) {
                sendJSON(res, 404, { error: 'Book not found.' });
                return;
            }

            sendJSON(res, 200, { message: 'Book deleted successfully.' });
            return;
        }

        // ==============================================
        // SUBMIT BOOK DONATION
        // ==============================================

        if (pathname === '/api/donations' && req.method === 'POST') {
            const user = await requireApiRole(req, res, ['user']);
            if (!user) return;

            const data = await readRequestBody(req);

            const title = data.title?.trim();
            const author = data.author?.trim();
            const status = data.status?.trim();
            const bookDescription = data.bookDescription?.trim();

            if (!title || !author || !status || !bookDescription) {
                sendJSON(res, 400, { error: 'All book fields are required.' });
                return;
            }

            const donation = {
                id: crypto.randomUUID(),
                title,
                author,
                status,
                bookDescription,
                donatedBy: user.username,
                donatedAt: nowWholeSeconds(),
                reviewStatus: 'pending'
            };

            await query(
                `INSERT INTO donateBook
                    (id, title, author, status, bookDescription, donatedBy, donatedAt, reviewStatus)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    donation.id,
                    donation.title,
                    donation.author,
                    donation.status,
                    donation.bookDescription,
                    donation.donatedBy,
                    donation.donatedAt,
                    donation.reviewStatus
                ]
            );

            sendJSON(res, 201, {
                message: 'Donation submitted successfully.',
                donation
            });

            return;
        }

        // ==============================================
        // GET PENDING DONATIONS
        // ==============================================

        if (pathname === '/api/donations' && req.method === 'GET') {
            const user = await requireApiRole(req, res, ['staff', 'admin']);
            if (!user) return;

            const donations = await query(
                `SELECT ${DONATION_COLUMNS} FROM donateBook
                 WHERE reviewStatus = 'pending'
                 ORDER BY donatedAt`
            );

            sendJSON(res, 200, donations);
            return;
        }

        // ==============================================
        // APPROVE / REJECT DONATION
        // ==============================================

        const donationMatch = pathname.match(
            /^\/api\/donations\/([^/]+)\/(approve|reject)$/
        );

        if (donationMatch && req.method === 'POST') {
            const user = await requireApiRole(req, res, ['staff', 'admin']);
            if (!user) return;

            const donationId = decodeURIComponent(donationMatch[1]);
            const decision = donationMatch[2];

            const found = await withTransaction(async connection => {
                // FOR UPDATE locks the row so two staff members cannot
                // review the same donation at the same time.
                const [rows] = await connection.execute(
                    `SELECT ${DONATION_COLUMNS} FROM donateBook
                     WHERE id = ? AND reviewStatus = 'pending'
                     FOR UPDATE`,
                    [donationId]
                );

                const donation = rows[0];
                if (!donation) return false;

                if (decision === 'approve') {
                    // INSERT IGNORE skips the book if a book with the same
                    // title and author is already in the library.
                    await connection.execute(
                        'INSERT IGNORE INTO referenceBookData (title, author, status, bookDescription) VALUES (?, ?, ?, ?)',
                        [
                            donation.title,
                            donation.author,
                            donation.status,
                            donation.bookDescription
                        ]
                    );
                }

                await connection.execute(
                    `UPDATE donateBook
                     SET reviewStatus = ?, reviewedBy = ?, reviewedAt = ?
                     WHERE id = ?`,
                    [
                        decision === 'approve' ? 'approved' : 'rejected',
                        user.username,
                        nowWholeSeconds(),
                        donationId
                    ]
                );

                return true;
            });

            if (!found) {
                sendJSON(res, 404, {
                    error: 'Pending donation not found.'
                });
                return;
            }

            sendJSON(res, 200, {
                message: decision === 'approve'
                    ? 'Donation approved and book added to the library.'
                    : 'Donation rejected.',
                decision,
                donationId
            });

            return;
        }

        // ==============================================
        // BORROW BOOK
        // ==============================================

        if (pathname === '/api/borrow' && req.method === 'POST') {
            const user = await requireApiLogin(req, res);
            if (!user) return;

            const data = await readRequestBody(req);
            const book = data.book;
            const input = data.username?.trim();

            if (!book || !input) {
                sendJSON(res, 400, {
                    error: 'Book and username are required.'
                });
                return;
            }

            // Staff type the student's registration number (e.g. s22310290)
            // or their email. Students do not need a login account.
            // If an email was typed, the part before "@" is saved as the
            // registration number.
            const username = input.includes('@')
                ? input.slice(0, input.indexOf('@'))
                : input;

            if (!username) {
                sendJSON(res, 400, {
                    error: 'Enter the student registration number or email.'
                });
                return;
            }

            // Send the reminder to the email that was typed, otherwise
            // to the student's university email (s22310290@student.unklab.ac.id).
            const email = input.includes('@')
                ? input
                : studentEmail(username);

            // So this loan is counted on the dashboard. A failure here
            // must not stop the loan, so it is only logged.
            await readyBorrowHistory().catch(error => {
                console.error('Could not create the borrowHistory table:', error.message);
            });

            // Move the book from referenceBookData to borrowedBook in one
            // transaction so it can never be lost or duplicated.
            const outcome = await withTransaction(async connection => {
                const [rows] = await connection.execute(
                    `SELECT ${BOOK_COLUMNS} FROM referenceBookData
                     WHERE title = ? AND author = ? FOR UPDATE`,
                    [book.title ?? '', book.author ?? '']
                );

                const borrowedBook = rows[0];

                if (!borrowedBook) {
                    return { error: 404, message: 'Book is no longer available.' };
                }

                // Server-side restriction for reference books.
                // This protects the rule even if a client bypasses the UI.
                if (
                    String(borrowedBook.status || '')
                        .toLowerCase()
                        .includes('reference')
                ) {
                    return { error: 403, message: 'Reference books cannot be borrowed.' };
                }

                await connection.execute(
                    'DELETE FROM referenceBookData WHERE title = ? AND author = ?',
                    [borrowedBook.title, borrowedBook.author]
                );

                const record = {
                    title: borrowedBook.title,
                    author: borrowedBook.author,
                    status: borrowedBook.status,
                    bookDescription: borrowedBook.bookDescription,
                    username,
                    borrowedAt: nowWholeSeconds()
                };

                await connection.execute(
                    `INSERT INTO borrowedBook
                        (title, author, status, bookDescription, username, borrowedAt)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        record.title,
                        record.author,
                        record.status,
                        record.bookDescription,
                        record.username,
                        record.borrowedAt
                    ]
                );

                // The dashboard history must never stop a loan, so an
                // error here is only logged.
                try {
                    await connection.execute(
                        `INSERT IGNORE INTO borrowHistory
                            (title, author, status, username, borrowedAt)
                         VALUES (?, ?, ?, ?, ?)`,
                        [
                            record.title,
                            record.author,
                            record.status,
                            record.username,
                            record.borrowedAt
                        ]
                    );
                } catch (error) {
                    console.error('Could not record borrow history:', error.message);
                }

                return { record };
            });

            if (outcome.error) {
                sendJSON(res, outcome.error, { error: outcome.message });
                return;
            }

            const borrowedRecord = outcome.record;

            const returnBy = dueDate(borrowedRecord);

            sendJSON(res, 200, {
                message: `Book borrowed successfully. Return by ${returnBy.toDateString()}.`,
                email,
                dueAt: returnBy
            });

            // White books have a 5-second delay.
            // All other books have a 20-second delay.
            const isWhiteBook = String(borrowedRecord.status || '')
                .toLowerCase()
                .includes('white');

            const notificationDelay = isWhiteBook ? 5000 : 20000;

            setTimeout(async () => {
                try {
                    const stillBorrowed = await query(
                        `SELECT username FROM borrowedBook
                         WHERE title = ? AND author = ? AND username = ? AND borrowedAt = ?
                         LIMIT 1`,
                        [
                            borrowedRecord.title,
                            borrowedRecord.author,
                            borrowedRecord.username,
                            borrowedRecord.borrowedAt
                        ]
                    );

                    if (stillBorrowed.length > 0) {
                        await sendLateReturnEmail(email, borrowedRecord);
                    }
                } catch (error) {
                    console.error('Late return check error:', error);
                }
            }, notificationDelay);

            return;
        }

        // ==============================================
        // GET BORROWED BOOKS
        // ==============================================

        if (pathname === '/api/borrowed-books' && req.method === 'GET') {
            const user = await requireApiRole(req, res, ['staff', 'admin']);
            if (!user) return;

            const borrowedBooks = await query(
                `SELECT ${BORROWED_COLUMNS} FROM borrowedBook ORDER BY borrowedAt`
            );

            sendJSON(res, 200, borrowedBooks.map(withLoanInfo));
            return;
        }

        // ==============================================
        // RETURN BOOK
        // ==============================================

        if (pathname === '/api/return' && req.method === 'POST') {
            const user = await requireApiRole(req, res, ['staff', 'admin']);
            if (!user) return;

            const data = await readRequestBody(req);
            const bookToReturn = data.book || data;

            if (!bookToReturn) {
                sendJSON(res, 400, {
                    error: 'Book information is required.'
                });
                return;
            }

            // Move the book from borrowedBook back to referenceBookData.
            // (title, author, username, borrowedAt) is borrowedBook's
            // primary key, so it identifies exactly one loan.
            const returnedBook = await withTransaction(async connection => {
                const [rows] = await connection.execute(
                    `SELECT ${BORROWED_COLUMNS} FROM borrowedBook
                     WHERE title = ? AND author = ? AND username = ? AND borrowedAt = ?
                     FOR UPDATE`,
                    [
                        bookToReturn.title ?? '',
                        bookToReturn.author ?? '',
                        bookToReturn.username ?? '',
                        toDate(bookToReturn.borrowedAt)
                    ]
                );

                const record = rows[0];
                if (!record) return null;

                await connection.execute(
                    `DELETE FROM borrowedBook
                     WHERE title = ? AND author = ? AND username = ? AND borrowedAt = ?`,
                    [record.title, record.author, record.username, record.borrowedAt]
                );

                try {
                    await connection.execute(
                        `UPDATE borrowHistory SET returnedAt = ?
                         WHERE title = ? AND author = ? AND username = ? AND borrowedAt = ?
                           AND returnedAt IS NULL`,
                        [
                            nowWholeSeconds(),
                            record.title,
                            record.author,
                            record.username,
                            record.borrowedAt
                        ]
                    );
                } catch (error) {
                    console.error('Could not update borrow history:', error.message);
                }

                // INSERT IGNORE: if staff re-added a book with the same
                // title and author while it was borrowed, keep that entry.
                await connection.execute(
                    'INSERT IGNORE INTO referenceBookData (title, author, status, bookDescription) VALUES (?, ?, ?, ?)',
                    [
                        record.title,
                        record.author,
                        record.status,
                        record.bookDescription
                    ]
                );

                return record;
            });

            if (!returnedBook) {
                sendJSON(res, 404, {
                    error: 'Borrowed book not found.'
                });
                return;
            }

            sendJSON(res, 200, {
                message: 'Book returned successfully.',
                book: withEmail(returnedBook)
            });

            return;
        }

        // ==============================================
        // DASHBOARD: FREQUENTLY BORROWED BOOKS
        // ==============================================
        // ?days=7|30|90|365 limits the period; anything else = all time.
        // Only counts are returned, never who borrowed a book.

        if (pathname === '/api/stats/popular-books' && req.method === 'GET') {
            const user = await requireApiLogin(req, res);
            if (!user) return;

            try {
                await readyBorrowHistory();
            } catch (error) {
                console.error('Could not create the borrowHistory table:', error);
                sendJSON(res, 500, {
                    error: `The borrowHistory table is missing and could not be created (${error.message}). ` +
                        'Create it with the SQL at the end of database/schema.sql.'
                });
                return;
            }

            const days = Number(requestURL.searchParams.get('days'));
            const since = [7, 30, 90, 365].includes(days)
                ? new Date(Date.now() - days * DAY_MS)
                : null;

            const where = since ? 'WHERE borrowedAt >= ?' : '';
            const params = since ? [since] : [];

            const topBooks = await query(
                `SELECT title, author, MAX(status) AS status,
                        COUNT(*) AS borrowCount, MAX(borrowedAt) AS lastBorrowedAt
                 FROM borrowHistory ${where}
                 GROUP BY title, author
                 ORDER BY borrowCount DESC, lastBorrowedAt DESC, title
                 LIMIT 10`,
                params
            );

            const [totals] = await query(
                `SELECT COUNT(*) AS totalBorrows,
                        COUNT(DISTINCT title, author) AS distinctBooks
                 FROM borrowHistory ${where}`,
                params
            );

            const byRoom = await query(
                `SELECT LOWER(TRIM(COALESCE(status, ''))) AS room, COUNT(*) AS borrowCount
                 FROM borrowHistory ${where}
                 GROUP BY room
                 ORDER BY borrowCount DESC`,
                params
            );

            const outNow = await query(
                'SELECT title, author, status, borrowedAt FROM borrowedBook'
            );
            const now = Date.now();

            sendJSON(res, 200, {
                periodDays: since ? days : null,
                totalBorrows: Number(totals?.totalBorrows || 0),
                distinctBooks: Number(totals?.distinctBooks || 0),
                currentlyBorrowed: outNow.length,
                overdue: outNow.filter(book => {
                    const due = dueDate(book);
                    return due && due.getTime() < now;
                }).length,
                byRoom: byRoom.map(row => ({
                    room: row.room || 'unknown',
                    borrowCount: Number(row.borrowCount)
                })),
                topBooks: topBooks.map(book => ({
                    title: book.title,
                    author: book.author,
                    status: book.status,
                    borrowCount: Number(book.borrowCount),
                    lastBorrowedAt: book.lastBorrowedAt
                }))
            });
            return;
        }

        // ==============================================
        // NEWS API
        // ==============================================

        if (pathname === '/api/news') {
            await handleNews(req, res);
            return;
        }

        // ==============================================
        // STATIC FILES AND PROTECTED PAGES
        // ==============================================

        if (!pathname.startsWith('/api')) {
            if (
                pathname.startsWith('/user/') ||
                pathname.startsWith('/staff/') ||
                pathname.startsWith('/admin/')
            ) {
                res.writeHead(301, {
                    Location: `/html${pathname}`,
                    'Cache-Control': 'no-store'
                });
                res.end();
                return;
            }

            const allowed = await checkProtectedPage(req, res);
            if (!allowed) return;

            await serveStatic(req, res, __dirname);
            return;
        }

        sendJSON(res, 404, { error: 'API route not found.' });

    } catch (error) {
        console.error('Request error:', error);

        sendJSON(res, 500, {
            error: 'An internal server error occurred.'
        });
    }
});

// ======================================================
// START SERVER
// ======================================================

try {
    const problems = await checkDatabase();

    console.log(
        `MySQL connected: ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`
    );

    try {
        await readyBorrowHistory();
    } catch (error) {
        problems.push(`Could not create the borrowHistory table: ${error.message}`);
    }

    if (problems.length) {
        console.warn('WARNING: the database does not match what server.js expects:');
        problems.forEach(problem => console.warn(`  - ${problem}`));
        console.warn('  See database/schema.sql for the expected tables and columns.');
    }
} catch (error) {
    console.error(
        `Could not connect to MySQL database "${DB_CONFIG.database}" at ` +
        `${DB_CONFIG.host}:${DB_CONFIG.port}. Is MySQL started in the XAMPP Control Panel, ` +
        'and does the database name in db.js match the one in phpMyAdmin?'
    );
    console.error(error.message);
}

server.listen(PORT, () => {
    console.log(`Connected on port: ${PORT}`);
    console.log(`Server URL: http://localhost:${PORT}`);
    console.log('Protected pages: /html/user/*, /html/staff/*, /html/admin/*');
});

// Close the MySQL pool and the Python process cleanly on Ctrl+C.
process.on('SIGINT', async () => {
    python.kill();
    await pool.end().catch(() => {});
    process.exit(0);
});
