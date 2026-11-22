const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const session = require('express-session');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: 'secret-key', resave: false, saveUninitialized: true }));

// مسار الصفحة الرئيسية
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// قاعدة بيانات وهمية
let users = {}; 
let bots = {}; 

// إعداد حساب الأدمن الثابت
const ADMIN_EMAIL = 'jaam@host.met';
const ADMIN_PASS = 'azoazo';

// مسار تخزين المشاريع: servers/email/projectName
function getBasePath(email) {
    const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
    return path.join(__dirname, 'servers', safeEmail);
}

// --- مسارات الحسابات ---
app.post('/api/register', (req, res) => {
    const { email, username, password } = req.body;
    if (!email || !username || !password) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    if (email === ADMIN_EMAIL || users[email]) return res.status(400).json({ error: 'البريد مستخدم بالفعل' });
    users[email] = { username, password };
    fs.ensureDirSync(getBasePath(email)); // إنشاء مجلد للمستخدم
    res.json({ success: true });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    // التحقق من الأدمن أو المستخدم العادي
    if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
        req.session.user = email;
        return res.json({ success: true });
    }
    if (users[email] && users[email].password === password) {
        req.session.user = email;
        return res.json({ success: true });
    }
    res.status(401).json({ error: 'بيانات الدخول خاطئة' });
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- إدارة المشاريع (الاستضافات) ---
app.get('/api/projects', (req, res) => {
    const email = req.session.user;
    if (!email) return res.status(401).json({ error: 'غير مسجل الدخول' });
    
    const basePath = getBasePath(email);
    fs.ensureDirSync(basePath);
    
    // قراءة المجلدات الموجودة داخل مجلد المستخدم
    fs.readdir(basePath, { withFileTypes: true }, (err, files) => {
        if (err) return res.status(500).json({ error: 'خطأ في قراءة المشاريع' });
        const projects = files.filter(f => f.isDirectory()).map(f => f.name);
        res.json({ projects });
    });
});

app.post('/api/projects/create', (req, res) => {
    const email = req.session.user;
    const { projectName } = req.body;
    if (!email) return res.status(401).json({ error: 'غير مسجل الدخول' });
    if (!projectName) return res.status(400).json({ error: 'اسم المشروع مطلوب' });

    const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const projectPath = path.join(getBasePath(email), safeName);

    if (fs.existsSync(projectPath)) {
        return res.status(400).json({ error: 'هذا الاسم موجود مسبقاً' });
    }

    fs.ensureDirSync(projectPath);
    res.json({ success: true, projectName: safeName });
});

// --- إدارة ملفات المشروع المحدد ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const email = req.session.user;
        const project = req.query.project;
        if (!email || !project) return cb(new Error('بيانات ناقصة'));
        
        const projectPath = path.join(getBasePath(email), project);
        fs.ensureDirSync(projectPath);
        cb(null, projectPath);
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage: storage });

app.get('/api/files', (req, res) => {
    const email = req.session.user;
    const project = req.query.project;
    if (!email || !project) return res.status(401).json({ error: 'بيانات ناقصة' });
    
    const projectPath = path.join(getBasePath(email), project);
    if (!fs.existsSync(projectPath)) return res.status(404).json({ error: 'المشروع غير موجود' });

    fs.readdir(projectPath, (err, files) => {
        if (err) return res.status(500).json({ error: 'خطأ في قراءة الملفات' });
        res.json({ files });
    });
});

app.post('/api/files/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم استلام أي ملف' });
    res.json({ success: true, filename: req.file.originalname });
});

// --- التحكم بالبوت للمشروع المحدد ---
function getBotKey(email, project) {
    return `${email}_${project}`;
}

function startBotProcess(email, projectPath, safeMainFile, projectName) {
    const botKey = getBotKey(email, projectName);
    let child;
    try {
        child = spawn(process.execPath, [safeMainFile], { cwd: projectPath });
    } catch (error) {
        bots[botKey].logs += `❌ فشل التشغيل: ${error.message}\n`;
        return;
    }

    bots[botKey].process = child;
    bots[botKey].mainFile = safeMainFile;

    child.stdout.on('data', (data) => { bots[botKey].logs += data.toString(); });
    child.stderr.on('data', (data) => { bots[botKey].logs += `ERROR: ${data.toString()}`; });

    child.on('close', (code) => {
        if (bots[botKey]) {
            bots[botKey].process = null;
            bots[botKey].logs += `\n--- البوت توقف (كود: ${code}) ---\n`;
        }
    });
}

app.post('/api/bot/start', (req, res) => {
    const email = req.session.user;
    const { project, mainFile } = req.body;
    if (!email || !project) return res.status(401).json({ error: 'بيانات ناقصة' });
    if (!mainFile) return res.status(400).json({ error: 'حدد ملف التشغيل' });

    const safeMainFile = path.basename(mainFile);
    const projectPath = path.join(getBasePath(email), project);

    if (!fs.existsSync(path.join(projectPath, safeMainFile))) {
        return res.status(400).json({ error: `الملف ${safeMainFile} غير موجود` });
    }

    const botKey = getBotKey(email, project);

    if (bots[botKey] && bots[botKey].process) {
        bots[botKey].process.kill();
    }

    if (!bots[botKey]) bots[botKey] = {};
    bots[botKey].logs = '⏳ جاري تجهيز البيئة...\n';
    bots[botKey].process = null;

    const hasPackageJson = fs.existsSync(path.join(projectPath, 'package.json'));

    if (hasPackageJson) {
        const installProcess = spawn('npm', ['install'], { cwd: projectPath, shell: true });

        installProcess.stdout.on('data', (data) => { bots[botKey].logs += data.toString(); });
        installProcess.stderr.on('data', (data) => { bots[botKey].logs += data.toString(); });

        installProcess.on('close', (code) => {
            if (code !== 0) {
                bots[botKey].logs += `\n❌ فشل التثبيت (كود: ${code})\n`;
                return;
            }
            bots[botKey].logs += '\n✅ اكتمل التثبيت. جاري التشغيل...\n\n';
            startBotProcess(email, projectPath, safeMainFile, project);
        });
    } else {
        bots[botKey].logs += '⚠️ لا يوجد package.json...\n\n';
        startBotProcess(email, projectPath, safeMainFile, project);
    }

    res.json({ success: true });
});

app.post('/api/bot/stop', (req, res) => {
    const email = req.session.user;
    const { project } = req.body;
    if (!email || !project) return res.status(401).json({ error: 'بيانات ناقصة' });

    const botKey = getBotKey(email, project);
    if (bots[botKey] && bots[botKey].process) {
        bots[botKey].process.kill();
        bots[botKey].process = null;
        bots[botKey].logs += '\n--- تم إيقاف البوت ---\n';
    }
    res.json({ success: true });
});

app.get('/api/bot/status', (req, res) => {
    const email = req.session.user;
    const { project } = req.query;
    if (!email || !project) return res.status(401).json({ error: 'بيانات ناقصة' });

    const botKey = getBotKey(email, project);
    const isRunning = !!(bots[botKey] && bots[botKey].process);
    const logs = bots[botKey] ? bots[botKey].logs : 'لا توجد سجلات.';
    res.json({ isRunning, logs });
});

// --- نقاط أخرى ---
app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/ping', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

module.exports = app;
