const fs = require('fs');
const path = require('path');

// 替换主脚本中的waitForTimeout
const mainFilePath = path.join(__dirname, 'xiaoheihe-auto-comment.js');
let mainContent = fs.readFileSync(mainFilePath, 'utf8');

// 替换所有page.waitForTimeout和postPage.waitForTimeout
mainContent = mainContent.replace(/await\s+(page|postPage)\.waitForTimeout\(([^)]+)\)/g, 'await new Promise(resolve => setTimeout(resolve, $2))');

fs.writeFileSync(mainFilePath, mainContent, 'utf8');
console.log('Replaced waitForTimeout in main script');

// 替换测试脚本中的waitForTimeout
const testFilePath = path.join(__dirname, 'test-cookies.js');
let testContent = fs.readFileSync(testFilePath, 'utf8');

testContent = testContent.replace(/await\s+page\.waitForTimeout\(([^)]+)\)/g, 'await new Promise(resolve => setTimeout(resolve, $1))');

fs.writeFileSync(testFilePath, testContent, 'utf8');
console.log('Replaced waitForTimeout in test script');

console.log('All replacements completed!');