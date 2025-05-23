const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const app = express();
app.use(express.json());

// ***************************************************************
// ** การแก้ไขที่สำคัญ: ลบการเรียกใช้ serviceAccountKey.json โดยตรง **
// ** Firebase Admin SDK จะโหลดข้อมูลรับรองจาก GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable โดยอัตโนมัติ (หากตั้งค่า) **
// ** หรือใช้ Project ID โดยตรงในโค้ดตามที่แก้ไขด้านล่าง **
// ***************************************************************

// ***************************************************************
// ** เพิ่ม try-catch block เพื่อดักจับ Error ระหว่างการเริ่มต้น Firebase Admin SDK **
// ***************************************************************
try {
  // **************************************************************************
  // ** แก้ไขที่นี่: ระบุ Project ID ของคุณโดยตรง **
  // ** ผมใช้ 'baking-course-register' ตามที่คุณเคยให้ใน Log ก่อนหน้านี้ **
  // ** หาก Project ID ของคุณไม่ใช่ 'baking-course-register' โปรดเปลี่ยนให้ถูกต้อง **
  // **************************************************************************
  admin.initializeApp({
    projectId: 'baking-course-register' // <--- **แทนที่ด้วย Project ID จริงๆ ของคุณ**
  });
  console.log('Firebase Admin SDK initialized successfully.'); // เพิ่ม log นี้เมื่อสำเร็จ
} catch (error) {
  // แสดง Error code และรายละเอียดเพื่อการ Debug ที่ดีขึ้น
  console.error('ERROR: Failed to initialize Firebase Admin SDK:', error.code, error.details || error.message);
  // หากการเชื่อมต่อ Firebase สำคัญมาก คุณอาจพิจารณาให้แอปพลิเคชันหยุดทำงานที่นี่
  // process.exit(1);
  // แต่สำหรับการ Debug ครั้งแรก ปล่อยให้มันรันต่อไปเพื่อดูว่ามี Error อื่นๆ หรือไม่
}


const db = admin.firestore();

// LINE_TOKEN ควรถูกดึงมาจาก Environment Variable เพื่อความปลอดภัย
const LINE_TOKEN = process.env.LINE_TOKEN; 

// ตรวจสอบว่า LINE_TOKEN มีค่าหรือไม่ (สำหรับการทำงานใน Production)
if (!LINE_TOKEN) {
  console.error('LINE_TOKEN environment variable is not set. LINE messages will not work correctly.');
  // ใน Production คุณอาจจะต้องการให้แอปพลิเคชันหยุดทำงานหรือแจ้งเตือนเมื่อไม่มี LINE_TOKEN
}


const FEATURES = {
  THEMED_CARDS: true,
  FUZZY_SEARCH: true,
  CATEGORY_SEARCH: true,
  QUICK_REPLY: true
};

// ดึง courses ที่เปิดสอนจาก Firestore
async function getOpenCourses() {
  const courses = [];
  try {
    const snapshot = await db.collection('courses').get();
    console.log('Firestore snapshot size:', snapshot.size);
    snapshot.forEach(doc => {
      const data = doc.data();
      // เช็ค field active เป็น true เท่านั้น
      if (data.active === true) {
        courses.push({
          id: doc.id,
          title: data.title || '',
          description: data.description || '',
          image: data.image || '',
          link: data.link || '',
          price: data.price || '',
          status: data.status || '',
          category: data.category || '',
          keyword: data.keyword || ''
        });
      }
    });
    console.log('Filtered courses:', courses.length);
  } catch (error) {
    // แสดง Error code และรายละเอียดเพื่อการ Debug ที่ดีขึ้น
    console.error('Error fetching courses from Firestore:', error.code, error.details || error.message);
  }
  return courses;
}


// Webhook รับจาก LINE
app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  const events = req.body.events;
  if (!events || events.length === 0) return;
  events.forEach(event => handleEvent(event).catch(console.error));
});

// จัดการแต่ละ event
async function handleEvent(event) {
  const userMessage = event.message?.text?.toLowerCase();
  const replyToken = event.replyToken;
  if (!userMessage || !replyToken) return;

  const courses = await getOpenCourses();

  if (userMessage.includes('ดูคอร์สทั้งหมด')) {
    if (courses.length === 0) {
      await sendTextReply(replyToken, 'ขณะนี้ยังไม่มีคอร์สที่เปิดสอนค่ะ');
    } else {
      await sendCoursesFlexInChunks(replyToken, courses);
    }
    return;
  }

  // ปรับปรุงการค้นหาหมวดหมู่ให้ยืดหยุ่นขึ้น
  if (FEATURES.CATEGORY_SEARCH && userMessage.startsWith('หมวดหมู่')) {
    const parts = userMessage.split(' ');
    if (parts.length > 1) {
      const category = parts.slice(1).join(' ').trim(); // รวมคำที่เหลือเป็นหมวดหมู่
      const filtered = courses.filter(c => (c.category || '').toLowerCase().includes(category));
      if (filtered.length > 0) {
        await sendCoursesFlexInChunks(replyToken, filtered);
      } else {
        await sendTextReply(replyToken, `ไม่พบคอร์สในหมวดหมู่ "${category}"`);
      }
    } else {
        await sendTextReply(replyToken, 'กรุณาระบุหมวดหมู่ที่ต้องการค้นหา เช่น "หมวดหมู่ เบเกอรี่"');
    }
    return;
  }
  
  // ใช้ fuzzy search ถ้าเปิดใช้งาน FEATURE นี้
  let matchedCourses = [];
  if (FEATURES.FUZZY_SEARCH) {
    matchedCourses = courses.filter(c =>
      (c.keyword || '').split(',').some(k => fuzzyMatch(userMessage, k)) ||
      fuzzyMatch(userMessage, c.title.toLowerCase())
    );
  } else {
    // Fallback to exact match if fuzzy search is disabled
    matchedCourses = courses.filter(c =>
      (c.keyword || '').toLowerCase().includes(userMessage) ||
      c.title.toLowerCase().includes(userMessage)
    );
  }
  

  if (matchedCourses.length > 0) {
    await sendCoursesFlexInChunks(replyToken, matchedCourses);
  } else {
    // ใช้ quick reply ถ้าเปิดใช้งาน FEATURE นี้
    if (FEATURES.QUICK_REPLY) {
      await sendTextWithQuickReply(replyToken, 'ไม่พบคอร์สที่เกี่ยวข้อง ลองเลือกจากเมนูด้านล่างนะคะ 👇');
    } else {
      await sendTextReply(replyToken, 'ไม่พบคอร์สที่เกี่ยวข้องค่ะ');
    }
  }
}

// fuzzy match แบบง่าย
function fuzzyMatch(input, target) {
  const i = input.toLowerCase().replace(/\s+/g, '');
  const t = target.toLowerCase().replace(/\s+/g, '');
  return t.includes(i) || i.includes(t);
}

// ส่ง Flex เป็นหลายรอบ (ถ้าเกิน 12)
async function sendCoursesFlexInChunks(replyToken, courses) {
  const chunks = [];
  for (let i = 0; i < courses.length; i += 12) {
    chunks.push(courses.slice(i, i + 12));
  }

  for (let i = 0; i < chunks.length; i++) {
    const message = {
      type: 'flex',
      altText: 'แนะนำคอร์สเรียน',
      contents: {
        type: 'carousel',
        contents: chunks[i].map(createFlexCard)
      }
    };
    await replyMessage(replyToken, message);
    if (i < chunks.length - 1) await delay(1000); // ป้องกัน rate-limit ของ LINE API
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// สร้าง Flex card
function createFlexCard(course) {
  const card = {
    type: 'bubble',
    size: 'mega',
    hero: {
      type: 'image',
      url: course.image || 'https://via.placeholder.com/640x360?text=No+Image',
      size: 'full',
      aspectRatio: '16:9',
      aspectMode: 'cover'
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'text',
          text: course.title,
          weight: 'bold',
          size: 'xl',
          color: FEATURES.THEMED_CARDS ? '#C1440E' : '#000000', // ใช้สีตาม Feature flag
          wrap: true
        },
        {
          type: 'text',
          text: course.description,
          size: 'sm',
          color: '#555555',
          wrap: true
        },
        {
          type: 'separator',
          margin: 'md'
        },
        {
          type: 'text',
          text: '💰 ราคา: ' + course.price + ' บาท',
          size: 'md',
          weight: 'bold',
          color: '#008080'
        }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#FFA07A',
          action: {
            type: 'uri',
            label: 'สมัครคอร์ส',
            uri: course.link || 'https://your-default-link.com'
          }
        }
      ]
    }
  };

  if (FEATURES.THEMED_CARDS) {
    card.styles = {
      body: { backgroundColor: '#FFF8F0' },
      footer: { backgroundColor: '#FFF0E0' }
    };
  }

  return card;
}

// ฟังก์ชันส่งข้อความแบบ reply
function replyMessage(replyToken, message) {
  if (!LINE_TOKEN) {
    console.warn('LINE_TOKEN is not set. Cannot send reply message.');
    return Promise.resolve(); // ป้องกันไม่ให้แอปพลิเคชัน Crash
  }
  return axios.post(
    'https://api.line.me/v2/bot/message/reply',
    {
      replyToken: replyToken,
      messages: [message]
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_TOKEN}`
      }
    }
  );
}

// ข้อความธรรมดา
function sendTextReply(replyToken, text) {
  return replyMessage(replyToken, {
    type: 'text',
    text: text
  });
}

// ข้อความพร้อม quick reply
function sendTextWithQuickReply(replyToken, text) {
  return replyMessage(replyToken, {
    type: 'text',
    text: text,
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'message', label: 'ดูคอร์สทั้งหมด', text: 'ดูคอร์สทั้งหมด' }
        },
        {
          type: 'action',
          action: { type: 'message', label: 'หมวดหมู่ เบเกอรี่', text: 'หมวดหมู่ เบเกอรี่' }
        },
        {
          type: 'action',
          action: { type: 'message', label: 'หมวดหมู่ เค้ก', text: 'หมวดหมู่ เค้ก' }
        }
      ]
    }
  });
}

// Route ทดสอบ
app.get('/test-courses', async (req, res) => {
  const courses = await getOpenCourses();
  res.json(courses);
});

// Route หน้าแรกทดสอบ
app.get('/', (req, res) => {
  res.send('Hello from your LINE Bot backend! Server is running.');
});

const PORT = process.env.PORT || 10000; // แก้เป็น 10000 เพื่อให้ Render ตรวจพบ
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
