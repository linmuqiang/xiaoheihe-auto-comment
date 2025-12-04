const puppeteer = require('puppeteer');
const fs = require('fs-extra');

// 从cookies文件读取内容
async function testCookiesFromEnv() {
  try {
    // 读取cookies文件内容
    const cookiesContent = await fs.readFile('./xiaoheihe-cookies.json', 'utf8');
    console.log('成功读取cookies文件');
    
    // 验证JSON格式
    const cookies = JSON.parse(cookiesContent);
    console.log(`cookies包含${cookies.length}个条目`);
    
    // 模拟环境变量设置
    process.env.XHH_COOKIES = cookiesContent;
    console.log('已将cookies设置到环境变量XHH_COOKIES');
    
    // 测试加载cookies函数
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });
    
    const page = await browser.newPage();
    
    // 测试加载cookies
    console.log('\n测试从环境变量加载cookies...');
    await loadCookies(page, './test-cookies.json');
    
    // 访问小黑盒首页，验证登录状态
    console.log('\n正在访问小黑盒首页...');
    await page.goto('https://www.xiaoheihe.cn/home', {
      waitUntil: ['networkidle2', 'domcontentloaded'],
      timeout: 60000
    });
    
    await page.waitForTimeout(5000);
    console.log('已成功访问小黑盒首页，cookies加载测试完成');
    
    await browser.close();
    console.log('\n测试完成，所有功能正常！');
  } catch (error) {
    console.error('测试失败：', error.message);
  }
}

// 复制主脚本中的loadCookies函数
async function loadCookies(page, filePath) {
  try {
    // 1. 首先尝试从环境变量读取cookies（GitHub Actions使用）
    const cookiesEnv = process.env.XHH_COOKIES;
    if (cookiesEnv) {
      console.log('正在从环境变量加载cookies...');
      try {
        const cookies = JSON.parse(cookiesEnv);
        await page.setCookie(...cookies);
        console.log('已成功从环境变量加载cookies');
        return true;
      } catch (e) {
        console.error('环境变量cookies格式错误：', e.message);
        // 继续尝试从文件加载
      }
    }
    
    // 2. 环境变量不存在或格式错误时，尝试从文件加载
    if (!await fs.pathExists(filePath)) {
      console.log(`cookies文件 ${filePath} 不存在`);
      return false;
    }
    
    const cookies = await fs.readJSON(filePath);
    if (!cookies || cookies.length === 0) {
      console.log('cookies文件内容为空');
      return false;
    }
    
    await page.setCookie(...cookies);
    console.log(`已成功从 ${filePath} 加载cookies`);
    return true;
  } catch (error) {
    console.error(`加载cookies失败：${error.message}`);
    return false;
  }
}

// 执行测试
testCookiesFromEnv();
