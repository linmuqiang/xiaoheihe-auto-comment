const puppeteer = require("puppeteer");
const schedule = require("node-schedule");
const fs = require("fs-extra");
const path = require("path");

// ==================== 核心配置（必须修改！）====================
const CONFIG = {
  // 登录信息（建议通过环境变量传入，避免硬编码）
  username: process.env.XHH_USERNAME || "19939162027",
  password: process.env.XHH_PASSWORD || "Fu134679",
  // 定时配置：每天随机时间执行（范围：9:00-21:00）
  randomTimeRange: [9, 21], // 小时范围
  // 评论内容库（随机选一条发送，更模拟人工）
  commentLib: [
    "哈哈，这个内容太有意思了！",
    "支持一下，分析得很到位～",
    "学到了，感谢分享！",
    "有点东西，马克一下",
    "确实不错，值得一看！",
    "太真实了，我也这么觉得",
    "求链接/资源！",
    "已三连，持续关注～"
  ],
  // 小黑盒DOM选择器（已提前适配，若平台更新需重新获取）
  selectors: {
    loginBtn: "button.login-btn", // 登录按钮
    phoneInput: "input[placeholder='手机号']", // 手机号输入框
    pwdInput: "input[placeholder='密码']", // 密码输入框
    submitLogin: "button.submit-login", // 登录提交按钮
    postList: "div.feed-item", // 帖子列表项（单个帖子）
    commentInput: "textarea[placeholder='来说点什么...']", // 评论输入框
    sendCommentBtn: "button.send-comment", // 发送评论按钮
    closePopup: "div.popup-close" // 关闭弹窗按钮（如广告、通知）
  },
  // 浏览器反爬配置
  browserOptions: {
    headless: "false", // 无头模式（调试时改为false，显示浏览器）
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ],
    defaultViewport: { width: 1920, height: 1080 },
    slowMo: 100 // 放慢操作速度（模拟人工）
  },
  cookiePath: path.join(__dirname, "xhh-cookie.json") // Cookie保存路径（避免重复登录）
};

// ==================== 工具函数 ====================
/**
 * 加载保存的Cookie（避免重复登录）
 */
async function loadCookie(page) {
  if (await fs.pathExists(CONFIG.cookiePath)) {
    const cookies = await fs.readJSON(CONFIG.cookiePath);
    await page.setCookie(...cookies);
    console.log("已加载保存的登录Cookie");
    return true;
  }
  console.log("未找到Cookie文件，需要重新登录");
  return false;
}

/**
 * 保存Cookie到本地
 */
async function saveCookie(page) {
  const cookies = await page.cookies();
  await fs.writeJSON(CONFIG.cookiePath, cookies, { spaces: 2 });
  console.log("登录Cookie已保存到本地");
}

/**
 * 小黑盒登录逻辑
 */
async function login(page) {
  try {
    // 访问登录页（小黑盒社区页未登录会自动跳转登录）
    await page.goto("https://www.xiaoheihe.cn/app/bbs/home", {
      waitUntil: "networkidle2"
    });

    // 关闭可能出现的弹窗（广告/通知）
    try {
      const closeBtn = await page.$(CONFIG.selectors.closePopup);
      if (closeBtn) await closeBtn.click();
    } catch (e) {}

    // 输入手机号和密码
    await page.waitForSelector(CONFIG.selectors.phoneInput, { timeout: 10000 });
    await page.type(CONFIG.selectors.phoneInput, CONFIG.username, { delay: 100 });
    await page.type(CONFIG.selectors.pwdInput, CONFIG.password, { delay: 100 });

    // 点击登录按钮
    await page.click(CONFIG.selectors.submitLogin);
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });

    // 验证登录是否成功（检查是否跳转到社区页）
    if (page.url().includes("/bbs/home")) {
      await saveCookie(page);
      console.log("登录成功！");
      return true;
    } else {
      console.error("登录失败：可能是账号密码错误或需要验证码");
      return false;
    }
  } catch (error) {
    console.error("登录异常：", error.message);
    return false;
  }
}

/**
 * 动态加载更多帖子（滚动页面）
 */
async function loadMorePosts(page, count = 30) {
  console.log("正在加载帖子列表...");
  let loadedCount = 0;

  while (loadedCount < count) {
    // 滚动到页面底部
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000); // 等待滚动加载

    // 统计已加载的帖子数量
    const posts = await page.$$(CONFIG.selectors.postList);
    loadedCount = posts.length;
    console.log(`已加载 ${loadedCount} 条帖子`);

    // 若加载数量不再增加，停止滚动
    if (loadedCount >= count) break;
  }

  return loadedCount;
}

/**
 * 随机选择一条帖子并点击
 */
async function selectRandomPost(page) {
  const posts = await page.$$(CONFIG.selectors.postList);
  if (posts.length === 0) throw new Error("未加载到任何帖子");

  // 随机选择一条（排除前3条可能的置顶帖，可选）
  const randomIndex = Math.floor(Math.random() * (posts.length - 3)) + 3;
  const selectedPost = posts[randomIndex];

  // 点击帖子（确保在可视区域）
  await selectedPost.scrollIntoView({ behavior: "smooth" });
  await page.waitForTimeout(1000);
  await selectedPost.click();
  console.log(`已随机选择第 ${randomIndex + 1} 条帖子`);

  // 切换到新标签页
  const pages = await page.browser().pages();
  const postPage = pages[pages.length - 1];
  await postPage.bringToFront();
  await postPage.waitForTimeout(2000); // 等待帖子详情页加载

  return postPage;
}

/**
 * 发送随机评论
 */
async function sendRandomComment(page) {
  // 随机选择一条评论内容
  const randomComment = CONFIG.commentLib[Math.floor(Math.random() * CONFIG.commentLib.length)];

  // 定位评论输入框并输入
  await page.waitForSelector(CONFIG.selectors.commentInput, { timeout: 15000 });
  await page.focus(CONFIG.selectors.commentInput);
  await page.waitForTimeout(500);

  // 逐字输入（模拟人工）
  for (const char of randomComment) {
    await page.keyboard.type(char);
    await page.waitForTimeout(Math.random() * 80 + 40);
  }

  // 点击发送按钮
  await page.click(CONFIG.selectors.sendCommentBtn);
  await page.waitForTimeout(2000);
  console.log(`已发送评论：${randomComment}`);
}

// ==================== 核心业务逻辑 ====================
async function autoCommentTask() {
  let browser;
  console.log(`\n[${new Date().toLocaleString()}] 开始执行小黑盒自动评论任务...`);

  try {
    // 1. 启动浏览器
    browser = await puppeteer.launch(CONFIG.browserOptions);
    const page = await browser.newPage();

    // 2. 反爬优化：清除自动化标识
    await page.evaluateOnNewDocument(() => {
      delete window.navigator.webdriver;
      Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
    });

    // 3. 加载Cookie或登录
    const cookieLoaded = await loadCookie(page);
    if (!cookieLoaded) {
      const loginSuccess = await login(page);
      if (!loginSuccess) throw new Error("登录失败，终止任务");
    }

    // 4. 重新访问社区页（确保登录状态生效）
    await page.goto("https://www.xiaoheihe.cn/app/bbs/home", { waitUntil: "networkidle2" });

    // 5. 加载足够多的帖子
    const postCount = await loadMorePosts(page, 50); // 加载50条帖子
    if (postCount < 10) throw new Error("帖子加载数量不足，可能被反爬限制");

    // 6. 随机选择并打开帖子
    const postPage = await selectRandomPost(page);

    // 7. 发送随机评论
    await sendRandomComment(postPage);

    console.log(`[${new Date().toLocaleString()}] 任务执行成功！`);
  } catch (error) {
    console.error(`[${new Date().toLocaleString()}] 任务执行失败：`, error.message);
  } finally {
    // 关闭浏览器
    if (browser) await browser.close();
  }
}

// ==================== 定时任务（每天随机时间执行）====================
function startRandomSchedule() {
  const [startHour, endHour] = CONFIG.randomTimeRange;

  // 生成每天随机执行时间（小时：startHour ~ endHour，分钟：0~59，秒：0~59）
  function getRandomExecuteTime() {
    const randomHour = Math.floor(Math.random() * (endHour - startHour + 1)) + startHour;
    const randomMinute = Math.floor(Math.random() * 60);
    const randomSecond = Math.floor(Math.random() * 60);
    return { hour: randomHour, minute: randomMinute, second: randomSecond };
  }

  // 首次执行：生成随机时间
  const firstExecuteTime = getRandomExecuteTime();
  const firstRule = new schedule.RecurrenceRule();
  firstRule.hour = firstExecuteTime.hour;
  firstRule.minute = firstExecuteTime.minute;
  firstRule.second = firstExecuteTime.second;

  console.log(`首次任务将在今天 ${firstExecuteTime.hour.toString().padStart(2, '0')}:${firstExecuteTime.minute.toString().padStart(2, '0')}:${firstExecuteTime.second.toString().padStart(2, '0')} 执行`);

  // 首次执行后，每天重新生成随机时间
  schedule.scheduleJob(firstRule, async () => {
    await autoCommentTask();

    // 后续每天重新生成随机时间并创建新任务
    setInterval(() => {
      const nextTime = getRandomExecuteTime();
      const nextRule = new schedule.RecurrenceRule();
      nextRule.hour = nextTime.hour;
      nextRule.minute = nextTime.minute;
      nextRule.second = nextTime.second;

      schedule.scheduleJob(nextRule, autoCommentTask);
      console.log(`下次任务将在明天 ${nextTime.hour.toString().padStart(2, '0')}:${nextTime.minute.toString().padStart(2, '0')}:${nextTime.second.toString().padStart(2, '0')} 执行`);
    }, 24 * 60 * 60 * 1000); // 每天执行一次
  });
}

// ==================== 启动程序 ====================
// 测试模式：直接执行一次（注释掉定时任务，取消下面注释）
// autoCommentTask();

// 正式模式：启动定时任务
startRandomSchedule();