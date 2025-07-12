// 1. นำเข้าไลบรารีที่จำเป็น
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const app = express();
app.use(express.json());

// **********************************************************************************
// ** การแก้ไขที่สำคัญที่สุด: ใช้ credential โดยตรงจาก Environment Variable **
// **********************************************************************************
let serviceAccount;
try {
  // พยายามแปลง GOOGLE_APPLICATION_CREDENTIALS_JSON จาก Environment Variable ให้เป็น JSON object
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    console.log('Service account JSON loaded from environment variable.');
  } else {
    console.error('ERROR: GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable is not set.');
    // หากไม่มี env var นี้ ให้ throw error เพื่อหยุดแอป
    throw new Error('Firebase credentials environment variable is missing.');
  }

  // เริ่มต้น Firebase Admin SDK ด้วย credential ที่ได้มาโดยตรง
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // projectId ไม่จำเป็นต้องระบุตรงนี้ ถ้ามีอยู่ใน serviceAccount แล้ว
    // แต่ถ้ายังติดปัญหา ก็ใส่ไปเลยก็ได้เพื่อความชัวร์
    projectId: serviceAccount.project_id // ดึง projectId จาก JSON credential โดยตรง
  });

  console.log('Firebase Admin SDK initialized successfully with explicit credentials.');
} catch (error) {
  console.error('ERROR: Failed to initialize Firebase Admin SDK:', error.message);
  // ใน Production ควรให้แอปหยุดทำงานถ้า Firebase init ล้มเหลว
  process.exit(1);
}

const db = admin.firestore();

// ... ส่วนที่เหลือของโค้ดของคุณเหมือนเดิม ...

// LINE_TOKEN ควรถูกดึงมาจาก Environment Variable เพื่อความปลอดภัย
const LINE_TOKEN = process.env.LINE_TOKEN;

// ตรวจสอบว่า LINE_TOKEN มีค่าหรือไม่
if (!LINE_TOKEN) {
  console.error('LINE_TOKEN environment variable is not set. LINE messages will not work correctly.');
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
    console.log('Attempting to query Firestore for "courses" collection.');
    const snapshot = await db.collection('courses').get();
    console.log('Firestore snapshot size:', snapshot.size); // **ดู Log นี้บน Render ว่าได้ 0 หรือมีจำนวน**

    if (snapshot.empty) {
      console.log('No documents found in "courses" collection or no active documents after filter.');
    }

    snapshot.forEach(doc => {
      const data = doc.data();
      // Debug: Log all documents found and their active status
      console.log(`Processing document ID: ${doc.id}, Active status: ${data.active}, Title: ${data.title}`); 

      // เช็ค field active เป็น true เท่านั้น
      if (data.active === true) { // ตรวจสอบว่าเป็น boolean true
        courses.push({
          id: doc.id,
          title: data.title || '',
          description: data.description || '',
          image: data.image || '',
          link: data.link || '',
          price: data.price || '',
          status: data.status || '', // ถ้าไม่มี status ใน Firestore ก็จะเป็น ''
          category: data.category || '',
          keyword: data.keyword || ''
        });
      }
    });
    console.log('Filtered active courses:', courses.length); // **ดู Log นี้บน Render ว่าได้ 0 หรือมีจำนวน**
  } catch (error) {
    console.error('Error fetching courses from Firestore:', error.code, error.details || error.message);
  }
  return courses;
}


// Webhook รับจาก LINE
app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  const events = req.body.events;
  if (!events || events.length === 0) {
    console.log('No events received in webhook.'); // Debugging line
    return;
  }
  console.log('Received LINE webhook events:', JSON.stringify(events, null, 2)); // Debugging line
  events.forEach(event => handleEvent(event).catch(console.error));
});

// จัดการแต่ละ event
async function handleEvent(event) {
  // ******** การเปลี่ยนแปลงอยู่ตรงนี้ ********
  // ตรวจสอบ Event การเพิ่มเพื่อน (Follow Event) ก่อนเป็นอันดับแรก
  if (event.type === 'follow') {
    console.log(`New user followed: ${event.source.userId}`);
    // ส่งข้อความต้อนรับ/รีวิวอัตโนมัติ
    await sendReviewFlex(event.replyToken);
    return; // จบการทำงานสำหรับ Event นี้
  }

  // ถ้าไม่ใช่ Follow Event ให้ทำงานกับ Message Event ตามปกติ
  const userMessage = event.message?.text?.toLowerCase();
  const replyToken = event.replyToken;
  console.log(`Handling event from user. Message: "${userMessage}", ReplyToken: ${replyToken}`); // Debugging line

  if (!userMessage || !replyToken) {
    console.warn('User message or reply token is missing.');
    return;
  }
  
  // ******** NEW FEATURE: รีวิววิดีโอ ********
  if (userMessage.includes('รีวิว') || userMessage.includes('vdo')) {
    await sendReviewFlex(replyToken);
    return; // จบการทำงานสำหรับเงื่อนไขนี้
  }

  const courses = await getOpenCourses(); // ดึงคอร์สจาก Firestore

  // เงื่อนไข 'ดูคอร์สทั้งหมด' หรือ 'สนใจ'
  if (userMessage.includes('ดูคอร์สทั้งหมด') || userMessage.includes('สนใจ')) {
    if (courses.length === 0) {
      await sendTextReply(replyToken, 'ขณะนี้ยังไม่มีคอร์สที่เปิดสอนค่ะ');
    } else {
      await sendCoursesFlexInChunks(replyToken, courses);
    }
    return; // สำคัญ: ต้อง return เพื่อไม่ให้ไปตรวจสอบเงื่อนไขอื่น
  }

  // ปรับปรุงการค้นหาหมวดหมู่ให้ยืดหยุ่นขึ้น
  if (FEATURES.CATEGORY_SEARCH && userMessage.startsWith('หมวดหมู่')) {
    const parts = userMessage.split(' ');
    if (parts.length > 1) {
      const category = parts.slice(1).join(' ').trim().toLowerCase(); // ทำให้เป็น lowercase
      const filtered = courses.filter(c => (c.category || '').toLowerCase().includes(category));
      if (filtered.length > 0) {
        await sendCoursesFlexInChunks(replyToken, filtered);
      } else {
        await sendTextReply(replyToken, `ไม่พบคอร์สในหมวดหมู่ "${category}" ค่ะ`);
      }
    } else {
        await sendTextReply(replyToken, 'กรุณาระบุหมวดหมู่ที่ต้องการค้นหา เช่น "หมวดหมู่ เบเกอรี่"');
    }
    return; // สำคัญ: ต้อง return
  }
 
  // ใช้ fuzzy search ถ้าเปิดใช้งาน FEATURE นี้ (สำหรับ keyword และ title)
  let matchedCourses = [];
  if (FEATURES.FUZZY_SEARCH) {
    matchedCourses = courses.filter(c => {
      const keywordMatches = (c.keyword || '').split(',').some(k => fuzzyMatch(userMessage, k));
      const titleMatches = fuzzyMatch(userMessage, c.title.toLowerCase());
      console.log(`Matching for "${userMessage}" - Course: "${c.title}" (Keyword: ${c.keyword}, Title: ${c.title.toLowerCase()}) => Keyword Match: ${keywordMatches}, Title Match: ${titleMatches}`); // Debugging match
      return keywordMatches || titleMatches;
    });
  } else {
    // Fallback to exact match if fuzzy search is disabled
    matchedCourses = courses.filter(c =>
      (c.keyword || '').toLowerCase().includes(userMessage) ||
      c.title.toLowerCase().includes(userMessage)
    );
  }
 
  console.log('Number of matched courses:', matchedCourses.length); // Debugging line

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
  const isMatch = t.includes(i) || i.includes(t);
  console.log(`Fuzzy Match: Input "${input}" vs Target "${target}" => Result: ${isMatch}`); // Debugging fuzzy match
  return isMatch;
}

// ส่ง Flex เป็นหลายรอบ (ถ้าเกิน 12)
async function sendCoursesFlexInChunks(replyToken, courses) {
  const chunks = [];
  for (let i = 0; i < courses.length; i += 12) {
    chunks.push(courses.slice(i, i + 12));
  }
  console.log(`Sending courses in ${chunks.length} chunks. Total courses: ${courses.length}`); // Debugging line

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

// ******** NEW FUNCTION: สร้างและส่ง Flex Message สำหรับรีวิว ********
async function sendReviewFlex(replyToken) {
  const reviewMessage = {
    type: 'flex',
    altText: 'วิดีโอรีวิวจากลูกค้า',
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        // **สำคัญ:** เปลี่ยนเป็น URL รูปภาพตัวอย่างของวิดีโอของคุณ
        url: 'https://placehold.co/600x400/E98074/FFFFFF?text=รีวิวจากลูกค้า',
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover',
        action: {
          type: 'uri',
          // **สำคัญ:** เปลี่ยนเป็น URL ของวิดีโอ TikTok ของคุณ
          uri: 'https://www.tiktok.com/@yourusername/video/yourvideoid'
        }
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: 'รีวิวจากลูกค้า',
            weight: 'bold',
            size: 'xl'
          },
          {
            type: 'text',
            text: 'ดูวิดีโอการทำขนมและบรรยากาศในคลาสเรียนของเราได้เลย!',
            wrap: true,
            margin: 'md'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            color: '#000000', // สีดำเหมือน TikTok
            action: {
              type: 'uri',
              label: '🎬 ดูวิดีโอรีวิว',
              // **สำคัญ:** เปลี่ยนเป็น URL ของวิดีโอ TikTok ของคุณ
              uri: 'https://vt.tiktok.com/ZSBCm9jRb/'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'uri',
              label: 'ไปที่โปรไฟล์ TikTok',
              // **สำคัญ:** เปลี่ยนเป็น URL โปรไฟล์ TikTok ของคุณ
              uri: 'https://www.tiktok.com/@namtarn.bakingstudio?_t=ZS-8xxLoOIwQYT&_r=1'
            }
          }
        ],
        flex: 0
      }
    }
  };
  return replyMessage(replyToken, reviewMessage);
}


// ฟังก์ชันส่งข้อความแบบ reply
function replyMessage(replyToken, message) {
  if (!LINE_TOKEN) {
    console.warn('LINE_TOKEN is not set. Cannot send reply message. Check Render Environment Variables.');
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
