const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const path = require("path");
const schedule = require("node-schedule");

// ==================== 全局变量 ====================
let isTaskRunning = false;

// ==================== 核心配置（可自定义修改）====================
const CONFIG = {
  // 用户账号密码（本地运行时使用硬编码，GitHub Actions 从环境变量读取）
  username: process.env.XHH_USERNAME || "19939162027",
  password: process.env.XHH_PASSWORD || "Fu134679",
  // Cookies配置
  useCookies: true, // 是否使用cookies登录
  cookiesFilePath: "./xiaoheihe-cookies.json", // cookies保存路径
  // 定时任务配置（支持多个时间点）
  scheduleConfig: [
    "0 8 * * *", // 每天早上8点
    "0 18 * * *" // 每天晚上6点
  ],
  // 执行时间：用于脚本内部日志
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
    phoneInput: "input[type='tel'], input[placeholder*='手机号']",
    pwdInput: "input[type='password'], input[placeholder*='密码']",
    submitLogin: "button[type='submit'], button[class*='login'], button[class*='submit']",
    postList: "div[class*='feed'], div[class*='post']",
    // 用户提供的准确CSS选择器（首选）
    // 注意：评论框默认是折叠状态，需要先点击展开
    commentInput: "#hb-website > div.hb-layout__main.hb-website__container.hb-page__app > div.hb-layout-main__container--main > div > div > div > div.hb-layout__fake-frame-container > div > div.link-reply.collapse.link-comment__reply > div > div.link-reply__input-wrapper",
    sendCommentBtn: "#hb-website > div.hb-layout__main.hb-website__container.hb-page__app > div.hb-layout-main__container--main > div > div > div > div.hb-layout__fake-frame-container > div > div.link-reply.expand.link-comment__reply > div > div > div.link-reply__menu-box > button.link-reply__menu-btn.hb-color__btn--confirm",
    closePopup: "div[class*='close'], button[class*='close'], svg[class*='close']"
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
 * 保存cookies到文件
 */
async function saveCookies(page, filePath) {
  try {
    const cookies = await page.cookies();
    await fs.writeJSON(filePath, cookies, { spaces: 2 });
    console.log(`已成功保存cookies到 ${filePath}`);
    return true;
  } catch (error) {
    console.error(`保存cookies失败：${error.message}`);
    return false;
  }
}

/**
 * 从文件或环境变量加载cookies
 */
async function loadCookies(page, filePath) {
  try {
    // 1. 首先尝试从环境变量读取cookies（GitHub Actions使用）
    const cookiesEnv = process.env.XHH_COOKIES;
    if (cookiesEnv) {
      console.log("正在从环境变量加载cookies...");
      try {
        const cookies = JSON.parse(cookiesEnv);
        await page.setCookie(...cookies);
        console.log("已成功从环境变量加载cookies");
        return true;
      } catch (e) {
        console.error("环境变量cookies格式错误：", e.message);
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
      console.log("cookies文件内容为空");
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

/**
 * 验证cookies是否有效
 */
async function validateCookies(page) {
  try {
    // 访问小黑盒首页，检查是否已登录
    await page.goto("https://www.xiaoheihe.cn/home", {
      waitUntil: ["networkidle2", "domcontentloaded"],
      timeout: 60000
    });
    
    await page.waitForTimeout(3000);
    
    // 检查当前URL是否包含登录标识
    const currentUrl = page.url();
    if (currentUrl.includes("/bbs/home") || currentUrl.includes("/app/bbs") || currentUrl.includes("/user")) {
      console.log("cookies有效，已成功登录");
      return true;
    }
    
    // 检查页面是否有用户信息或登录成功标识
    const hasUserInfo = await page.evaluate(() => {
      return !!document.querySelector(".user-info, .user-avatar, [class*='user']");
    });
    
    if (hasUserInfo) {
      console.log("cookies有效，已成功登录");
      return true;
    }
    
    console.log("cookies无效，需要重新登录");
    return false;
  } catch (error) {
    console.error(`验证cookies失败：${error.message}`);
    return false;
  }
}

/**
 * 小黑盒登录逻辑（优先使用cookies登录，失败则使用账号密码登录）
 */
async function login(page) {
  // 优先尝试使用cookies登录
  if (CONFIG.useCookies) {
    console.log("正在尝试使用cookies登录...");
    
    // 1. 从文件加载cookies
    const loaded = await loadCookies(page, CONFIG.cookiesFilePath);
    if (loaded) {
      // 2. 验证cookies是否有效
      const isValid = await validateCookies(page);
      if (isValid) {
        return true;
      }
    }
    
    console.log("cookies登录失败，将使用账号密码登录");
  }
  
  try {
    // 使用账号密码登录
    // 使用指定的登录链接
    const loginUrl = "https://login.xiaoheihe.cn/"; // 小黑盒官方登录页面
    await page.goto(loginUrl, {
      waitUntil: ["networkidle2", "domcontentloaded"],
      timeout: 60000
    });
    
    console.log("已进入登录页面");

    // 等待页面完全加载，包括Vue应用
    await page.waitForTimeout(5000);
    
    // 尝试点击页面，触发可能的动态内容加载
    try {
      await page.click("body");
      console.log("已点击页面，尝试触发动态内容加载");
      await page.waitForTimeout(2000);
    } catch (e) {
      console.log("点击页面失败，忽略");
    }
    
    // 查找并点击密码登录选项
    console.log("正在查找密码登录选项...");
    
    // 方式1：使用用户提供的准确CSS选择器
    const userProvidedSelector = "#app > div > div.main > div.login-container > div > div.bottom-bar > div.btn.left-btn > span";
    let passwordLoginBtn = null;
    
    try {
      passwordLoginBtn = await page.$(userProvidedSelector);
      if (passwordLoginBtn) {
        console.log(`使用用户提供的CSS选择器找到密码登录选项：${userProvidedSelector}`);
      }
    } catch (e) {
      console.log(`用户提供的选择器查找失败：`, e.message);
    }
    
    // 方式2：如果用户提供的选择器失败，使用通用选择器查找
    if (!passwordLoginBtn) {
      console.log("用户提供的选择器失败，尝试使用通用选择器查找...");
      const passwordLoginSelectors = [
        ".left-btn",
        ".btn.left-btn",
        "[class*='left'][class*='btn']",
        "div.bottom-bar div.btn:first-child",
        "span:contains('密码登录')",
        "a[class*='password']",
        "a[class*='pwd']",
        ".password-login",
        ".pwd-login"
      ];
      
      for (const selector of passwordLoginSelectors) {
        try {
          const elements = await page.$$(selector);
          for (const element of elements) {
            try {
              // 检查元素是否可见
              const isVisible = await page.evaluate(el => {
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
              }, element);
              
              if (isVisible) {
                passwordLoginBtn = element;
                console.log(`找到密码登录选项：${selector}`);
                break;
              }
            } catch (e) {
              continue;
            }
          }
          
          if (passwordLoginBtn) break;
        } catch (e) {
          console.log(`尝试查找${selector}失败：`, e.message);
          continue;
        }
      }
    }
    
    // 方式2：如果通用选择器失败，使用JavaScript查找包含特定文本的可点击元素
    if (!passwordLoginBtn) {
      console.log("通用选择器失败，尝试使用JavaScript查找包含特定文本的可点击元素...");
      
      const passwordLoginText = ["密码登录", "密码", "PWD", "password"];
      
      for (const text of passwordLoginText) {
        try {
          const elementHandle = await page.evaluateHandle((targetText) => {
            // 查找所有可能的可点击元素
            const elements = document.querySelectorAll('a, button, div[role="button"], span[role="button"], li[role="button"]');
            
            for (const element of elements) {
              // 检查元素文本是否包含目标文本
              if (element.textContent && element.textContent.includes(targetText)) {
                // 检查元素是否可见
                const style = window.getComputedStyle(element);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                  // 检查元素是否可点击
                  if (element.tagName === 'A' || element.tagName === 'BUTTON' || element.hasAttribute('role') || element.style.cursor === 'pointer') {
                    return element;
                  }
                }
              }
            }
            
            return null;
          }, text);
          
          // 检查是否找到元素
          const isFound = await page.evaluate(el => el !== null, elementHandle);
          if (isFound) {
            passwordLoginBtn = elementHandle;
            console.log(`通过JavaScript找到包含"${text}"的可点击元素`);
            break;
          }
        } catch (e) {
          console.log(`JavaScript查找"${text}"失败：`, e.message);
          continue;
        }
      }
    }
    
    // 方式3：如果还是没找到，尝试使用JavaScript直接执行点击操作
    if (!passwordLoginBtn) {
      console.log("尝试使用JavaScript直接执行点击操作...");
      
      try {
        const isClicked = await page.evaluate(() => {
          // 查找所有包含"密码登录"文本的元素的父元素
          const elements = document.querySelectorAll('a, span, div, button');
          
          for (const element of elements) {
            if (element.textContent && element.textContent.includes('密码登录')) {
              // 找到可点击的父元素或祖先元素
              let clickableElement = element;
              
              // 向上查找可点击的元素
              for (let i = 0; i < 5 && clickableElement; i++) {
                if (clickableElement.tagName === 'A' || 
                    clickableElement.tagName === 'BUTTON' || 
                    clickableElement.hasAttribute('role') || 
                    clickableElement.style.cursor === 'pointer') {
                  // 执行点击
                  clickableElement.click();
                  return true;
                }
                clickableElement = clickableElement.parentElement;
              }
            }
          }
          
          return false;
        });
        
        if (isClicked) {
          console.log("通过JavaScript直接执行点击操作成功");
          await page.waitForTimeout(3000); // 等待切换完成
        } else {
          console.log("JavaScript直接点击失败");
        }
      } catch (e) {
        console.log("JavaScript直接点击异常：", e.message);
      }
    }
    
    // 方式4：尝试点击登录页面的其他位置，可能触发密码登录选项显示
    if (!passwordLoginBtn) {
      console.log("尝试点击登录页面其他位置...");
      try {
        // 点击页面右上角的切换图标
        const switchIcons = await page.$$("svg, i[class*='icon'], [class*='toggle'], [class*='switch']");
        for (const icon of switchIcons) {
          try {
            await icon.click();
            console.log("已点击切换图标");
            await page.waitForTimeout(2000);
            break;
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        console.log("点击切换图标失败：", e.message);
      }
    }
    
    // 如果找到密码登录按钮，使用多种方式尝试点击
    if (passwordLoginBtn) {
      try {
        console.log("尝试点击密码登录选项...");
        
        // 方式1：直接点击
        try {
          await passwordLoginBtn.click();
          console.log("方式1：直接点击成功");
        } catch (e1) {
          console.log("方式1：直接点击失败，尝试方式2...");
          
          // 方式2：滚动到可见区域后点击
          await passwordLoginBtn.scrollIntoView({ behavior: "smooth", block: "center" });
          await page.waitForTimeout(1000);
          
          try {
            await passwordLoginBtn.click();
            console.log("方式2：滚动后点击成功");
          } catch (e2) {
            console.log("方式2：滚动后点击失败，尝试方式3...");
            
            // 方式3：使用JavaScript点击
            await page.evaluate(el => el.click(), passwordLoginBtn);
            console.log("方式3：JavaScript点击成功");
          }
        }
        
        await page.waitForTimeout(3000); // 等待切换完成
      } catch (e) {
        console.log("点击密码登录选项最终失败：", e.message);
      }
    } else {
      console.log("未找到密码登录选项，继续执行...");
    }

    // 关闭可能的弹窗
    try {
      // 尝试多种弹窗关闭方式
      const closeSelectors = [
        "div[class*='close']",
        "button[class*='close']",
        "svg[class*='close']",
        ".popup-close"
      ];
      
      for (const selector of closeSelectors) {
        const closeBtns = await page.$$(selector);
        for (const btn of closeBtns) {
          try {
            await btn.click();
            console.log("已关闭弹窗");
            await page.waitForTimeout(1000);
          } catch (e) {
            // 忽略点击失败
          }
        }
      }
    } catch (e) {
      console.log("无弹窗需要关闭");
    }

    // 查找手机号输入框（兼容多种选择器）
    console.log("正在查找手机号输入框...");
    const phoneSelectors = [
      "input[type='tel']",
      "input[placeholder*='手机号']",
      "input[name='phone']",
      ".phone-input input"
    ];
    
    let phoneInput = null;
    for (const selector of phoneSelectors) {
      try {
        phoneInput = await page.waitForSelector(selector, { timeout: 5000 });
        console.log(`找到手机号输入框：${selector}`);
        break;
      } catch (e) {
        continue;
      }
    }
    
    if (!phoneInput) {
      throw new Error("未找到手机号输入框");
    }

    // 查找密码输入框（终极优化方案）
    console.log("正在查找密码输入框...");
    let pwdInput = null;
    
    // 方式1：尝试通过JavaScript查找所有输入框，然后过滤出密码输入框
    try {
      console.log("尝试通过JavaScript查找所有输入框...");
      const inputElements = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input"));
        return inputs.map((input, index) => {
          return {
            index,
            type: input.type,
            placeholder: input.placeholder,
            name: input.name,
            id: input.id,
            className: input.className,
            tagName: input.tagName,
            outerHTML: input.outerHTML
          };
        });
      });
      
      console.log(`找到 ${inputElements.length} 个输入框：`);
      inputElements.forEach(input => {
        console.log(`  输入框 ${input.index}：type=${input.type}, placeholder=${input.placeholder}, name=${input.name}, id=${input.id}`);
      });
      
      // 过滤出密码输入框或可能的密码输入框
      const passwordInputs = inputElements.filter(input => 
        input.type === 'password' || 
        input.placeholder.includes('密码') || 
        input.name.includes('password') ||
        input.id.includes('password') ||
        input.className.includes('password') ||
        input.className.includes('pwd')
      );
      
      if (passwordInputs.length > 0) {
        const targetIndex = passwordInputs[0].index;
        pwdInput = await page.$$("input");
        pwdInput = pwdInput[targetIndex];
        console.log(`通过JavaScript找到密码输入框，索引：${targetIndex}`);
      }
    } catch (e) {
      console.log("JavaScript查找失败：", e.message);
    }
    
    // 方式2：如果JavaScript查找失败，尝试通过坐标定位
    if (!pwdInput) {
      console.log("尝试通过坐标定位...");
      try {
        // 先点击手机号输入框，然后按Tab键切换到密码输入框
        await phoneInput.click();
        await page.waitForTimeout(500);
        await page.keyboard.press("Tab");
        await page.waitForTimeout(500);
        
        // 获取当前焦点元素
        const focusedElement = await page.evaluate(() => {
          return document.activeElement.outerHTML;
        });
        
        console.log(`当前焦点元素：${focusedElement}`);
        
        // 检查当前焦点元素是否是输入框
        if (focusedElement.includes("input")) {
          pwdInput = await page.evaluateHandle(() => document.activeElement);
          console.log("通过Tab键切换找到密码输入框");
        }
      } catch (e) {
        console.log("坐标定位失败：", e.message);
      }
    }
    
    // 方式3：如果还是没找到，尝试使用最基础的选择器
    if (!pwdInput) {
      console.log("尝试使用基础选择器...");
      try {
        // 查找所有输入框
        const allInputs = await page.$$("input");
        if (allInputs.length >= 2) {
          // 假设第二个输入框是密码输入框
          pwdInput = allInputs[1];
          console.log("假设第二个输入框是密码输入框");
        } else if (allInputs.length === 1) {
          // 只有一个输入框，可能是动态生成的
          pwdInput = allInputs[0];
          console.log("只有一个输入框，假设是密码输入框");
        }
      } catch (e) {
        console.log("基础选择器失败：", e.message);
      }
    }
    
    // 如果还是没找到，保存页面结构用于调试
    if (!pwdInput) {
      console.log("正在保存页面结构用于调试...");
      const pageHtml = await page.content();
      const timestamp = Date.now();
      const htmlPath = `login-page-${timestamp}.html`;
      await fs.writeFile(htmlPath, pageHtml);
      console.log(`已保存登录页面HTML：${htmlPath}`);
      
      // 保存更详细的页面信息
      const pageInfo = await page.evaluate(() => {
        return {
          title: document.title,
          url: window.location.href,
          inputCount: document.querySelectorAll("input").length,
          formCount: document.querySelectorAll("form").length,
          scriptCount: document.querySelectorAll("script").length,
          stylesheetCount: document.querySelectorAll("link[rel='stylesheet']").length
        };
      });
      
      console.log("页面详细信息：", pageInfo);
      
      throw new Error("未找到密码输入框");
    }

    // 输入手机号
    console.log("正在输入手机号...");
    await phoneInput.type(CONFIG.username, { delay: 100 });
    
    // 检查是否是验证码登录模式
    const currentPlaceholder = await page.evaluate(el => el.placeholder, pwdInput);
    console.log(`检测到输入框占位符：${currentPlaceholder}`);
    
    if (currentPlaceholder.includes('验证码') || currentPlaceholder.includes('短信') || currentPlaceholder.includes('code')) {
      console.log("检测到验证码登录模式");
      
      // 查找获取验证码按钮
      try {
        const getCodeSelectors = [
          "button[class*='code']",
          "button[class*='send']",
          "button:contains('获取验证码')",
          "button[text*='验证码']",
          ".send-code",
          ".get-code"
        ];
        
        let getCodeBtn = null;
        for (const selector of getCodeSelectors) {
          try {
            getCodeBtn = await page.$(selector);
            if (getCodeBtn) {
              console.log(`找到获取验证码按钮：${selector}`);
              break;
            }
          } catch (e) {
            continue;
          }
        }
        
        if (getCodeBtn) {
          console.log("点击获取验证码按钮...");
          await getCodeBtn.click();
          console.log("已发送验证码请求，请在手机上查看验证码");
          
          // 这里可以添加人工输入验证码的逻辑
          // 但由于是自动化脚本，我们将跳过验证码处理
          throw new Error("当前为验证码登录模式，暂不支持自动处理");
        }
      } catch (e) {
        console.log("获取验证码按钮处理失败：", e.message);
      }
      
      throw new Error("登录模式为验证码登录，暂不支持自动处理");
    } else {
      // 密码登录模式
      console.log("检测到密码登录模式，正在输入密码...");
      await pwdInput.type(CONFIG.password, { delay: 100 });
    }

    // 处理可能的同意协议复选框
    console.log("正在检查同意协议复选框...");
    try {
      const agreeSelectors = [
        "input[type='checkbox'][class*='agree']",
        "input[type='checkbox'][name*='agree']",
        ".agree-checkbox input",
        "label[class*='agree']"
      ];
      
      for (const selector of agreeSelectors) {
        const checkboxes = await page.$$(selector);
        for (const checkbox of checkboxes) {
          try {
            const isChecked = await page.evaluate(el => {
              if (el.tagName === 'INPUT' && el.type === 'checkbox') {
                return el.checked;
              }
              return false;
            }, checkbox);
            
            if (!isChecked) {
              await checkbox.click();
              console.log("已勾选同意协议");
              await page.waitForTimeout(500);
            }
          } catch (e) {
            // 忽略点击失败
          }
        }
      }
    } catch (e) {
      console.log("无同意协议复选框或处理失败");
    }

    // 查找登录按钮
    console.log("正在查找登录按钮...");
    
    // 方式1：使用用户提供的准确CSS选择器
    const userProvidedLoginSelector = "#app > div > div.main > div.login-container > div > div.btn-container > div";
    
    // 方式2：使用通用选择器查找登录按钮
    const loginSelectors = [
      userProvidedLoginSelector, // 优先使用用户提供的选择器
      "button[type='submit']",
      "button[class*='login']",
      "button[class*='submit']",
      ".login-btn",
      ".submit-btn",
      "[class*='btn'][class*='login']",
      "[class*='login'][class*='btn']",
      "button:has-text('登录')",
      "button[text*='登录']",
      "#login-button",
      ".login-container button:last-child",
      ".form-login button",
      ".login-form button",
      "[class*='login-box'] button",
      ".btn-container div",
      ".btn-container button",
      ".bottom-bar button",
      ".main button",
      "button"
    ];
    
    let loginBtn = null;
    let loginSelector = null;
    
    // 先尝试快速查找
    for (const selector of loginSelectors) {
      try {
        const buttons = await page.$$(selector);
        for (const button of buttons) {
          try {
            // 检查按钮是否可见
            const isVisible = await page.evaluate(el => {
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            }, button);
            
            if (isVisible) {
              loginBtn = button;
              loginSelector = selector;
              console.log(`找到登录按钮：${selector}`);
              break;
            }
          } catch (e) {
            continue;
          }
        }
        
        if (loginBtn) break;
      } catch (e) {
        console.log(`尝试查找${selector}失败：`, e.message);
        continue;
      }
    }
    
    // 方式2：如果快速查找失败，尝试等待查找
    if (!loginBtn) {
      console.log("快速查找失败，尝试等待查找...");
      for (const selector of loginSelectors) {
        try {
          loginBtn = await page.waitForSelector(selector, { timeout: 3000 });
          loginSelector = selector;
          console.log(`等待查找找到登录按钮：${selector}`);
          break;
        } catch (e) {
          continue;
        }
      }
    }
    
    // 方式3：如果还是没找到，尝试使用JavaScript查找包含特定文本的按钮
    if (!loginBtn) {
      console.log("尝试使用JavaScript查找包含特定文本的按钮...");
      
      try {
        loginBtn = await page.evaluateHandle(() => {
          const buttons = document.querySelectorAll('button');
          
          for (const button of buttons) {
            if (button.textContent && button.textContent.includes('登录')) {
              // 检查按钮是否可见
              const style = window.getComputedStyle(button);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                return button;
              }
            }
          }
          
          // 如果没找到包含"登录"的按钮，返回第一个可见的按钮
          for (const button of buttons) {
            const style = window.getComputedStyle(button);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              return button;
            }
          }
          
          return null;
        });
        
        // 检查是否找到元素
        const isFound = await page.evaluate(el => el !== null, loginBtn);
        if (isFound) {
          console.log("通过JavaScript找到登录按钮");
        }
      } catch (e) {
        console.log("JavaScript查找失败：", e.message);
      }
    }
    
    // 方式4：如果还是没找到，尝试使用最基础的方式
    if (!loginBtn) {
      console.log("尝试使用最基础的方式查找登录按钮...");
      try {
        // 查找所有按钮
        const allButtons = await page.$$("button");
        if (allButtons.length > 0) {
          // 选择第一个可见的按钮作为登录按钮
          for (const button of allButtons) {
            try {
              const isVisible = await page.evaluate(el => {
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
              }, button);
              
              if (isVisible) {
                loginBtn = button;
                console.log("选择第一个可见按钮作为登录按钮");
                break;
              }
            } catch (e) {
              continue;
            }
          }
        }
      } catch (e) {
        console.log("最基础方式失败：", e.message);
      }
    }
    
    if (!loginBtn) {
      throw new Error("未找到登录按钮");
    }

    // 点击登录（多种方式尝试）
    console.log("正在点击登录...");
    try {
      // 方式1：直接点击
      await loginBtn.click();
      console.log("使用直接点击方式");
    } catch (e) {
      console.log("直接点击失败，尝试其他方式...");
      
      // 方式2：滚动到可见区域后点击
      await loginBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      await page.waitForTimeout(1000);
      
      try {
        await loginBtn.click();
        console.log("使用滚动后点击方式");
      } catch (e2) {
        console.log("滚动后点击失败，尝试JS点击...");
        
        // 方式3：使用JavaScript点击
        await page.evaluate((sel) => {
          const btn = document.querySelector(sel);
          if (btn) {
            btn.click();
          }
        }, loginSelector);
        console.log("使用JavaScript点击方式");
      }
    }
    
    // 等待登录结果
    try {
      await page.waitForNavigation({ 
        waitUntil: ["networkidle2", "domcontentloaded"], 
        timeout: 60000 
      });
    } catch (e) {
      console.log("登录跳转超时，检查当前页面状态...");
    }

    // 验证登录成功
    console.log(`登录后跳转至：${page.url()}`);
    
    // 检查是否有验证码提示
    try {
      const captchaElements = await page.$$(".captcha, [class*='captcha'], [name*='captcha'], input[type='text'][placeholder*='验证码']");
      if (captchaElements.length > 0) {
        console.log("检测到验证码，当前脚本暂不支持自动处理验证码");
        await page.screenshot({ path: `captcha-required-${Date.now()}.png` });
        console.log("已保存验证码截图");
        throw new Error("登录失败：需要验证码");
      }
    } catch (e) {
      console.log("无验证码或检测失败");
    }
    
    // 检查是否有错误提示
    try {
      const errorSelectors = [".error-message", ".tips-error", ".toast-error", ".alert-danger", "[class*='error']"];
      for (const selector of errorSelectors) {
        const errorElements = await page.$$(selector);
        for (const errorEl of errorElements) {
          const errorText = await errorEl.textContent();
          if (errorText && errorText.trim()) {
            throw new Error(`登录失败：${errorText.trim()}`);
          }
        }
      }
    } catch (e) {
      console.log("错误提示检测失败");
    }
    
    // 登录成功，保存cookies
    if (CONFIG.useCookies) {
      await saveCookies(page, CONFIG.cookiesFilePath);
    }
    
    if (page.url().includes("/bbs/home") || page.url().includes("/app/bbs") || page.url().includes("/user")) {
      console.log("登录成功！");
      return true;
    } else if (page.url().includes("/login") || page.url().includes("login.xiaoheihe.cn")) {
      // 检查是否登录成功但停留在登录页面
      try {
        const userInfoElements = await page.$$(".user-info, [class*='user'], [id*='user']");
        if (userInfoElements.length > 0) {
          console.log("登录成功，用户信息已显示");
          return true;
        }
      } catch (e) {
        // 忽略检查失败
      }
      throw new Error("登录失败：账号密码错误或需要验证码");
    } else {
      // 其他页面也可能是登录成功
      console.log("登录成功，跳转至其他页面");
      return true;
    }
  } catch (error) {
    console.error("登录异常：", error.message);
    // 保存页面截图用于调试
    await page.screenshot({ path: `login-error-${Date.now()}.png` });
    console.log("已保存登录失败截图");
    return false;
  }
}

/**
 * 动态加载更多帖子（滚动页面）
 */
async function loadMorePosts(page, count = 30) {
  console.log("正在加载帖子列表...");
  let loadedCount = 0;
  let scrollAttempts = 0;
  const maxAttempts = 15;

  // 先检查当前URL，确保在首页
  const currentUrl = page.url();
  console.log(`当前页面URL：${currentUrl}`);
  
  // 如果不在首页，跳转到首页
  if (!currentUrl.includes("home") && !currentUrl.includes("bbs")) {
    console.log("不在首页，跳转到首页...");
    await page.goto("https://www.xiaoheihe.cn/home", {
      waitUntil: ["networkidle2", "domcontentloaded"],
      timeout: 60000
    });
    await page.waitForTimeout(3000);
  }

  // 尝试多种帖子选择器
  const postSelectors = [
    CONFIG.selectors.postList,
    "div[class*='feed-item']",
    "div[class*='post-item']",
    "div[class*='bbs-item']",
    "div[class*='article']",
    "div[class*='content-item']",
    ".feed-item",
    ".post-item",
    ".bbs-item",
    "article",
    "section[class*='feed']",
    "div[class*='list'] div[class*='item']"
  ];

  while (loadedCount < count && scrollAttempts < maxAttempts) {
    // 尝试所有帖子选择器
    for (const selector of postSelectors) {
      const posts = await page.$$(selector);
      const count = posts.length;
      if (count > loadedCount) {
        loadedCount = count;
        console.log(`使用选择器 "${selector}" 已加载 ${loadedCount} 条帖子`);
        break;
      }
    }

    if (loadedCount >= count) break;

    // 滚动页面加载更多
    console.log(`滚动页面，尝试加载更多帖子...（尝试次数：${scrollAttempts + 1}/${maxAttempts}）`);
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(4000); // 延长等待时间，确保内容加载
    
    // 尝试点击可能的加载更多按钮
    try {
      const loadMoreSelectors = [
        "button[class*='load-more']",
        "button[class*='more']",
        "a[class*='load-more']",
        ".load-more-btn",
        "[class*='load-more']",
        "[class*='more']:not([class*='comment']):not([class*='reply'])"
      ];
      
      for (const selector of loadMoreSelectors) {
        const loadMoreBtn = await page.$(selector);
        if (loadMoreBtn) {
          console.log(`找到加载更多按钮：${selector}`);
          await loadMoreBtn.click();
          await page.waitForTimeout(3000);
          break;
        }
      }
    } catch (e) {
      console.log("无加载更多按钮或点击失败");
    }

    scrollAttempts++;
    
    // 如果多次尝试后仍未加载到帖子，尝试重新刷新页面
    if (scrollAttempts % 5 === 0 && loadedCount === 0) {
      console.log("多次尝试后仍未加载到帖子，尝试刷新页面...");
      await page.reload({ waitUntil: ["networkidle2", "domcontentloaded"] });
      await page.waitForTimeout(5000);
    }
  }

  console.log(`帖子加载完成，共加载 ${loadedCount} 条帖子`);
  return loadedCount;
}

/**
 * 随机选择一条帖子并点击
 */
async function selectRandomPost(page) {
  console.log("正在随机选择帖子...");
  
  // 生成1-10之间的随机数
  const randomNum = Math.floor(Math.random() * 10) + 1;
  console.log(`生成随机数：${randomNum}`);
  
  // 使用用户提供的CSS选择器，将nth-child的数字替换为随机数
  const userPostSelector = `#hb-website > div.hb-layout__main.hb-website__container.hb-page__app > div.hb-layout-main__container--main > div > div > div > div.hb-layout__fake-frame-container > div > div.hb-cpt__scroll-list.bbs-home__content-list > a:nth-child(${randomNum}) > div.bbs-content__title`;
  
  console.log(`使用用户提供的CSS选择器：${userPostSelector}`);
  
  try {
    // 等待帖子元素可见
    await page.waitForSelector(userPostSelector, { timeout: 15000, state: 'visible' });
    
    // 优化：直接使用page.click()方法，它内部会重新查找元素，避免引用失效问题
    // 先滚动到元素位置
    await page.evaluate(selector => {
      const element = document.querySelector(selector);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, userPostSelector);
    
    await page.waitForTimeout(2000);
    
    // 直接使用page.click()，避免元素引用失效
    await page.click(userPostSelector);
    console.log(`已点击第 ${randomNum} 条帖子`);
    
    // 等待新标签页打开
    await page.waitForTimeout(3000);
    
    // 切换到新标签页
    const pages = await page.browser().pages();
    const postPage = pages[pages.length - 1];
    await postPage.bringToFront();
    await postPage.waitForTimeout(5000);
    
    return postPage;
  } catch (e) {
    console.error(`使用用户提供的选择器点击帖子失败：${e.message}`);
    console.log("尝试使用备用选择器...");
    
    // 备用方案：使用原有的帖子选择逻辑
    // 首先使用loadMorePosts中成功加载51条帖子的选择器
    const mainPostSelector = "div[class*='list'] div[class*='item']";
    let posts = await page.$$(mainPostSelector);
    
    console.log(`使用主选择器 "${mainPostSelector}" 找到 ${posts.length} 条帖子`);
    
    // 如果主选择器失败，尝试其他选择器
    if (posts.length === 0) {
      // 使用与loadMorePosts相同的帖子选择器
      const postSelectors = [
        CONFIG.selectors.postList,
        "div[class*='feed-item']",
        "div[class*='post-item']",
        "div[class*='bbs-item']",
        "div[class*='article']",
        "div[class*='content-item']",
        ".feed-item",
        ".post-item",
        ".bbs-item",
        "article",
        "section[class*='feed']",
        "a[class*='bbs-content']",
        ".bbs-home__content-list a",
        "#hb-website div.bbs-home__content-list a"
      ];
      
      for (const selector of postSelectors) {
        const foundPosts = await page.$$(selector);
        if (foundPosts.length > 0) {
          posts = foundPosts;
          console.log(`使用选择器 "${selector}" 找到 ${posts.length} 条帖子`);
          break;
        }
      }
    }
    
    if (posts.length === 0) throw new Error("未加载到任何帖子");

    // 随机选择一条帖子，在1-10范围内
    const randomIndex = Math.min(randomNum - 1, posts.length - 1);
    const selectedPost = posts[randomIndex];

    await selectedPost.scrollIntoView({ behavior: "smooth", block: "center" });
    await page.waitForTimeout(2000);
    
    // 点击帖子
    try {
      await selectedPost.click();
      console.log(`已随机选择第 ${randomIndex + 1} 条帖子`);
    } catch (e) {
      console.log(`直接点击帖子失败，尝试使用JavaScript点击...`);
      await page.evaluate(el => el.click(), selectedPost);
      console.log(`已使用JavaScript随机选择第 ${randomIndex + 1} 条帖子`);
    }

    // 等待新标签页打开
    await page.waitForTimeout(3000);
    
    // 切换到新标签页
    const pages = await page.browser().pages();
    const postPage = pages[pages.length - 1];
    await postPage.bringToFront();
    await postPage.waitForTimeout(5000);

    return postPage;
  }
}

/**
 * 发送随机评论
 */
async function sendRandomComment(page) {
  console.log("正在发送随机评论...");
  
  const randomComment = CONFIG.commentLib[Math.floor(Math.random() * CONFIG.commentLib.length)];
  console.log(`准备发送评论：${randomComment}`);

  // 先检查当前页面URL
  const currentUrl = page.url();
  console.log(`当前帖子页面URL：${currentUrl}`);
  
  // 保存页面截图，便于调试
  await page.screenshot({ path: `post-page-${Date.now()}.png` });
  console.log("已保存帖子页面截图");
  
  // 尝试多种评论输入框选择器
  // 注意：评论框默认是折叠状态，需要先点击展开
  const commentInputSelectors = [
    CONFIG.selectors.commentInput, // 用户提供的折叠状态评论框
    "#hb-website > div.hb-layout__main.hb-website__container.hb-page__app > div.hb-layout-main__container--main > div > div > div > div.hb-layout__fake-frame-container > div > div.link-reply.collapse.link-comment__reply > div > div.link-reply__input-wrapper",
    "#hb-website > div.hb-layout__main.hb-website__container.hb-page__app > div.hb-layout-main__container--main > div > div > div > div.hb-layout__fake-frame-container > div > div.link-reply.expand.link-comment__reply > div > div",
    "textarea[placeholder*='说点什么']",
    "textarea[placeholder*='评论']",
    "textarea[placeholder*='写下你的评论']",
    "textarea[placeholder*='写点什么']",
    "textarea[placeholder*='留下你的评论']",
    "textarea[class*='comment']",
    "textarea[class*='input']",
    ".comment-input",
    ".comment-textarea",
    "#comment-input",
    "textarea",
    "input[type='text'][class*='comment']",
    "input[type='text'][placeholder*='评论']",
    "input[type='text']",
    "div[class*='comment'] textarea",
    "div[class*='input'] textarea",
    ".reply-box textarea",
    ".comment-box textarea",
    "#app textarea",
    "#app input[type='text']",
    ".main textarea",
    ".content textarea",
    "section textarea",
    "article textarea"
  ];

  let commentInput = null;
  
  // 首先尝试处理评论框的折叠/展开状态
  console.log("正在处理评论框的折叠/展开状态...");
  
  // 1. 先尝试点击折叠状态的评论框，展开它
  try {
    const collapseSelector = CONFIG.selectors.commentInput;
    console.log(`尝试点击折叠状态的评论框：${collapseSelector}`);
    await page.click(collapseSelector);
    console.log("已点击折叠状态的评论框，评论框已展开");
    await page.waitForTimeout(2000); // 等待评论框展开
  } catch (e) {
    console.log(`点击折叠状态评论框失败：${e.message}`);
  }
  
  // 2. 查找展开后的评论输入框
  console.log("正在查找展开后的评论输入框...");
  
  // 首先尝试快速查找，不等待
  for (const selector of commentInputSelectors) {
    try {
      const elements = await page.$$(selector);
      if (elements.length > 0) {
        commentInput = elements[0];
        console.log(`快速找到评论输入框：${selector}`);
        break;
      }
    } catch (e) {
      console.log(`快速查找${selector}失败：`, e.message);
      continue;
    }
  }
  
  // 如果快速查找失败，尝试等待查找
  if (!commentInput) {
    console.log("快速查找失败，尝试等待查找...");
    for (const selector of commentInputSelectors) {
      try {
        commentInput = await page.waitForSelector(selector, { timeout: 3000 });
        console.log(`等待找到评论输入框：${selector}`);
        break;
      } catch (e) {
        console.log(`等待查找${selector}失败：`, e.message);
        continue;
      }
    }
  }
  
  // 如果还是没找到，尝试使用JavaScript查找
  if (!commentInput) {
    console.log("尝试使用JavaScript查找评论输入框...");
    try {
      // 先获取页面上所有的输入元素，保存到文件便于调试
      const inputElements = await page.evaluate(() => {
        const elements = document.querySelectorAll('textarea, input[type="text"]');
        return Array.from(elements).map((el, index) => ({
          index,
          tagName: el.tagName,
          type: el.type,
          placeholder: el.placeholder,
          className: el.className,
          id: el.id,
          outerHTML: el.outerHTML,
          isVisible: window.getComputedStyle(el).display !== 'none'
        }));
      });
      
      console.log(`页面上找到 ${inputElements.length} 个输入元素`);
      inputElements.forEach(el => {
        console.log(`  输入元素 ${el.index}：${el.tagName} ${el.type}，placeholder：${el.placeholder}，className：${el.className}，可见：${el.isVisible}`);
      });
      
      // 尝试找到可见的输入元素
      for (const el of inputElements) {
        if (el.isVisible) {
          commentInput = await page.$$(el.tagName === 'TEXTAREA' ? 'textarea' : 'input[type="text"]');
          commentInput = commentInput[el.index];
          console.log(`通过JavaScript找到可见的输入元素，索引：${el.index}`);
          break;
        }
      }
      
      // 如果还是没找到，选择第一个输入元素
      if (!commentInput && inputElements.length > 0) {
        commentInput = await page.$$(inputElements[0].tagName === 'TEXTAREA' ? 'textarea' : 'input[type="text"]');
        commentInput = commentInput[0];
        console.log("选择第一个输入元素作为评论输入框");
      }
    } catch (e) {
      console.log("JavaScript查找评论输入框失败：", e.message);
      throw new Error("未找到评论输入框");
    }
  }
  
  // 最后的尝试：执行滚动，可能评论输入框在页面下方
  if (!commentInput) {
    console.log("最后尝试：滚动页面查找评论输入框...");
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(2000);
    
    try {
      commentInput = await page.$("textarea, input[type='text']");
      if (commentInput) {
        console.log("滚动后找到输入元素");
      } else {
        throw new Error("滚动后仍未找到输入元素");
      }
    } catch (e) {
      console.log("滚动后查找失败：", e.message);
      throw new Error("未找到评论输入框");
    }
  }

  // 聚焦并输入评论
  await commentInput.focus();
  await page.waitForTimeout(500);

  // 逐字输入
  for (const char of randomComment) {
    await page.keyboard.type(char);
    await page.waitForTimeout(Math.random() * 80 + 40);
  }

  // 尝试多种发送按钮选择器
  const sendBtnSelectors = [
    CONFIG.selectors.sendCommentBtn,
    "button[class*='send']",
    "button[class*='comment']",
    "button[type='submit']",
    ".send-comment",
    ".comment-btn",
    "#send-comment",
    "button:contains('发送')",
    "button:contains('评论')",
    "button[text*='发送']",
    "button[text*='评论']"
  ];

  let sendBtn = null;
  
  // 查找发送按钮
  for (const selector of sendBtnSelectors) {
    try {
      sendBtn = await page.$(selector);
      if (sendBtn) {
        console.log(`找到发送按钮：${selector}`);
        break;
      }
    } catch (e) {
      console.log(`尝试查找${selector}失败：`, e.message);
      continue;
    }
  }
  
  // 如果没找到发送按钮，尝试使用JavaScript查找
  if (!sendBtn) {
    console.log("尝试使用JavaScript查找发送按钮...");
    try {
      sendBtn = await page.evaluateHandle(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent && (btn.textContent.includes('发送') || btn.textContent.includes('评论'))) {
            return btn;
          }
        }
        return buttons[buttons.length - 1] || null;
      });
      
      const isFound = await page.evaluate(el => el !== null, sendBtn);
      if (isFound) {
        console.log("通过JavaScript找到发送按钮");
      }
    } catch (e) {
      console.log("JavaScript查找发送按钮失败：", e.message);
      throw new Error("未找到发送按钮");
    }
  }

  // 点击发送
  try {
    await sendBtn.click();
    console.log("点击发送按钮成功");
  } catch (e) {
    console.log("直接点击发送按钮失败，尝试使用JavaScript点击...");
    await page.evaluate(el => el.click(), sendBtn);
    console.log("使用JavaScript点击发送按钮成功");
  }
  
  await page.waitForTimeout(3000);
  console.log(`已发送评论：${randomComment}`);
  console.log("评论发送完成！");
}

// ==================== 核心业务逻辑（支持定时执行）====================
async function autoCommentTask() {
  // 避免任务重复执行
  if (isTaskRunning) {
    console.log(`[${new Date().toLocaleString()}] 任务正在执行中，跳过本次调用`);
    return;
  }

  isTaskRunning = true;
  let browser;
  console.log(`\n[${new Date().toLocaleString()}] 开始执行小黑盒自动评论任务...`);

  try {
    // 启动浏览器（适配本地环境和 CI 环境）
    // 在 GitHub Actions 环境中使用无头模式，本地环境使用有头模式
    const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
    
    browser = await puppeteer.launch({
      ...CONFIG.browserOptions,
      headless: isCI ? "new" : false, // CI环境使用无头模式，本地使用有头模式
      args: [
        ...CONFIG.browserOptions.args,
        "--no-sandbox", // CI环境必需
        "--disable-setuid-sandbox", // CI环境必需
        "--disable-gpu", // 禁用GPU加速
        "--disable-dev-shm-usage", // 避免共享内存问题
        "--window-size=1920,1080",
        "--disable-blink-features=AutomationControlled",
        "--ozone-platform=wayland", // 解决X服务器问题
        "--enable-features=UseOzonePlatform",
        "--ozone-platform-hint=wayland"
      ]
    });
    const page = await browser.newPage();

    // 反爬优化
    await page.evaluateOnNewDocument(() => {
      delete window.navigator.webdriver;
      Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
    });

    // 登录（每次运行重新登录）
    const loginSuccess = await login(page);
    if (!loginSuccess) throw new Error("登录失败，终止任务");

    // 点击社区链接，确保在正确的页面
    console.log("正在点击社区链接...");
    const communitySelector = "#app > div.header.add-border.color-opacity-white.position-top > div > div.nav-wrapper > div > ul > li:nth-child(2) > a";
    
    try {
      const communityLink = await page.$(communitySelector);
      if (communityLink) {
        await communityLink.click();
        console.log("已点击社区链接");
        await page.waitForNavigation({ waitUntil: ["networkidle2", "domcontentloaded"], timeout: 60000 });
        await page.waitForTimeout(3000);
      } else {
        console.log("未找到社区链接，尝试使用通用选择器...");
        
        // 尝试通用选择器
        const communitySelectors = [
          "a[href*='bbs']",
          "a[href*='community']",
          "a:contains('社区')",
          "a[text*='社区']",
          ".nav-item:has(a:contains('社区')) a",
          "ul.nav > li:nth-child(2) a"
        ];
        
        for (const selector of communitySelectors) {
          try {
            const link = await page.$(selector);
            if (link) {
              await link.click();
              console.log(`已点击社区链接：${selector}`);
              await page.waitForNavigation({ waitUntil: ["networkidle2", "domcontentloaded"], timeout: 60000 });
              await page.waitForTimeout(3000);
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }
    } catch (e) {
      console.log("点击社区链接失败：", e.message);
    }

    // 随机选帖 + 发送评论（直接使用用户提供的CSS选择器，跳过帖子加载流程）
    const postPage = await selectRandomPost(page);
    await sendRandomComment(postPage);

    console.log(`[${new Date().toLocaleString()}] 任务执行成功！`);
  } catch (error) {
    console.error(`[${new Date().toLocaleString()}] 任务执行失败：`, error.message);
    console.log(`[${new Date().toLocaleString()}] 定时任务将继续运行，等待下一次触发...`);
  } finally {
    if (browser) await browser.close();
    isTaskRunning = false;
  }
}

// ==================== 定时任务调度 ====================
function scheduleTasks() {
  console.log(`[${new Date().toLocaleString()}] 开始初始化定时任务...`);
  
  // 遍历所有定时配置
  CONFIG.scheduleConfig.forEach((cronExpression, index) => {
    try {
      schedule.scheduleJob(cronExpression, () => {
        console.log(`\n[${new Date().toLocaleString()}] 触发定时任务 ${index + 1}：${cronExpression}`);
        autoCommentTask();
      });
      console.log(`✅ 定时任务 ${index + 1} 已创建：${cronExpression}`);
    } catch (error) {
      console.error(`❌ 创建定时任务 ${index + 1} 失败：${error.message}`);
    }
  });
  
  console.log(`\n[${new Date().toLocaleString()}] 所有定时任务初始化完成！`);
  console.log("📅 定时任务列表：");
  CONFIG.scheduleConfig.forEach((cron, index) => {
    console.log(`   ${index + 1}. ${cron}（Cron 表达式）`);
  });
  console.log("\n🚀 脚本正在运行，等待定时触发...");
}

// ==================== 启动脚本 ====================
// 检测是否在CI/CD环境中运行
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

if (isCI) {
  // 在CI/CD环境中（如GitHub Actions），只执行一次任务
  console.log(`[${new Date().toLocaleString()}] 在CI/CD环境中运行，只执行一次任务...`);
  autoCommentTask().then(() => {
    console.log(`[${new Date().toLocaleString()}] 任务执行完成，脚本退出`);
    // 任务完成后退出进程
    process.exit(0);
  }).catch((error) => {
    console.error(`[${new Date().toLocaleString()}] 任务执行失败：`, error.message);
    process.exit(1);
  });
} else {
  // 在本地环境中，执行一次任务并启动定时服务
  console.log(`[${new Date().toLocaleString()}] 脚本启动，立即执行一次任务进行验证...`);
  autoCommentTask();
  
  // 启动定时任务
  setTimeout(() => {
    scheduleTasks();
  }, 30000); // 30秒后启动定时任务，避免与立即执行的任务冲突
}