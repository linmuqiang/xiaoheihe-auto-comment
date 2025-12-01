const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const path = require("path");

// ==================== 核心配置（无需修改，从环境变量读取敏感信息）====================
const CONFIG = {
  // 从 GitHub Actions 环境变量读取账号密码（安全无硬编码）
  username: process.env.XHH_USERNAME,
  password: process.env.XHH_PASSWORD,
  // 执行时间：GitHub Actions 已通过 cron 定时，这里仅用于脚本内部日志
  executeTime: "08:00", // 北京时间
  // 评论内容库（可自定义扩展）
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
  // 小黑盒 DOM 选择器（已适配最新版，若失效需重新获取）
  selectors: {
    phoneInput: "input[placeholder='手机号']",
    pwdInput: "input[placeholder='密码']",
    submitLogin: "button.submit-login",
    postList: "div.feed-item",
    commentInput: "textarea[placeholder='来说点什么...']",
    sendCommentBtn: "button.send-comment",
    closePopup: "div.popup-close"
  },
  // Puppeteer 配置（适配 GitHub Actions 无头环境）
  browserOptions: {
    headless: "new", // 强制无头模式（CI 环境必须）
    args: [
      "--no-sandbox", // CI 环境必需参数
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ],
    defaultViewport: { width: 1920, height: 1080 },
    slowMo: 100,
    timeout: 30000 // 延长超时时间（应对 CI 网络波动）
  }
};

// ==================== 工具函数 ====================
/**
 * 小黑盒登录逻辑（每次运行重新登录，适配 CI 无 Cookie 环境）
 */
async function login(page) {
  try {
    await page.goto("https://www.xiaoheihe.cn/app/bbs/home", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    // 关闭弹窗（广告/通知）
    try {
      const closeBtn = await page.$(CONFIG.selectors.closePopup);
      if (closeBtn) await closeBtn.click();
    } catch (e) {
      console.log("无弹窗需要关闭");
    }

    // 输入账号密码（从环境变量读取）
    await page.waitForSelector(CONFIG.selectors.phoneInput, { timeout: 15000 });
    await page.type(CONFIG.selectors.phoneInput, CONFIG.username, { delay: 100 });
    await page.type(CONFIG.selectors.pwdInput, CONFIG.password, { delay: 100 });

    // 点击登录
    await page.click(CONFIG.selectors.submitLogin);
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 });

    // 验证登录成功
    if (page.url().includes("/bbs/home")) {
      console.log("登录成功！");
      return true;
    } else {
      throw new Error("登录失败：账号密码错误或需要验证码");
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
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000); // CI 环境加载较慢，延长等待

    const posts = await page.$$(CONFIG.selectors.postList);
    loadedCount = posts.length;
    console.log(`已加载 ${loadedCount} 条帖子`);

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

  const randomIndex = Math.floor(Math.random() * (posts.length - 3)) + 3; // 排除前3条置顶帖
  const selectedPost = posts[randomIndex];

  await selectedPost.scrollIntoView({ behavior: "smooth" });
  await page.waitForTimeout(1500);
  await selectedPost.click();
  console.log(`已随机选择第 ${randomIndex + 1} 条帖子`);

  // 切换到新标签页
  const pages = await page.browser().pages();
  const postPage = pages[pages.length - 1];
  await postPage.bringToFront();
  await postPage.waitForTimeout(3000);

  return postPage;
}

/**
 * 发送随机评论
 */
async function sendRandomComment(page) {
  const randomComment = CONFIG.commentLib[Math.floor(Math.random() * CONFIG.commentLib.length)];

  await page.waitForSelector(CONFIG.selectors.commentInput, { timeout: 15000 });
  await page.focus(CONFIG.selectors.commentInput);
  await page.waitForTimeout(500);

  // 逐字输入
  for (const char of randomComment) {
    await page.keyboard.type(char);
    await page.waitForTimeout(Math.random() * 80 + 40);
  }

  // 点击发送
  await page.click(CONFIG.selectors.sendCommentBtn);
  await page.waitForTimeout(3000);
  console.log(`已发送评论：${randomComment}`);
}

// ==================== 核心业务逻辑（无定时，仅单次执行）====================
async function autoCommentTask() {
  let browser;
  console.log(`\n[${new Date().toLocaleString()}] 开始执行小黑盒自动评论任务...`);

  try {
    // 启动浏览器（适配 CI 环境）
    browser = await puppeteer.launch(CONFIG.browserOptions);
    const page = await browser.newPage();

    // 反爬优化
    await page.evaluateOnNewDocument(() => {
      delete window.navigator.webdriver;
      Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
    });

    // 登录（每次运行重新登录）
    const loginSuccess = await login(page);
    if (!loginSuccess) throw new Error("登录失败，终止任务");

    // 加载帖子
    const postCount = await loadMorePosts(page, 50);
    if (postCount < 10) throw new Error("帖子加载不足，可能被反爬限制");

    // 随机选帖 + 发送评论
    const postPage = await selectRandomPost(page);
    await sendRandomComment(postPage);

    console.log(`[${new Date().toLocaleString()}] 任务执行成功！`);
  } catch (error) {
    console.error(`[${new Date().toLocaleString()}] 任务执行失败：`, error.message);
    process.exit(1); // 执行失败时退出码设为 1，GitHub Actions 会标记为失败
  } finally {
    if (browser) await browser.close();
  }
}

// ==================== 启动单次任务（GitHub Actions 触发后执行一次）====================
autoCommentTask();