import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'
import fs from 'fs'
import fetch from 'node-fetch'

/**
 * 格式化中文日期为 yyyy年MM月dd日
 * 例如：2025年7月7日 => 2025年07月07日
 */
function formatChineseDate(dateStr) {
    const m = dateStr && dateStr.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!m) return dateStr || '未知';
    const [, y, mo, d] = m;
    return `${y}年${String(mo).padStart(2, '0')}月${String(d).padStart(2, '0')}日`;
}

/**
 * 计算下次可续期日期（到期日前一天）
 */
function getNextRenewAvailableDate(chineseDate) {
    const m = chineseDate.match(/(\d{4})年(\d{2})月(\d{2})日/);
    if (!m) return '未知';
    const [_, y, mo, d] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    dt.setDate(dt.getDate() - 1); // 前一天
    return `${dt.getFullYear()}年${String(dt.getMonth() + 1).padStart(2, '0')}月${String(dt.getDate()).padStart(2, '0')}日`;
}

/**
 * Sends a notification message to a Telegram chat.
 */
async function sendTelegramMessage(message) {
    const botToken = process.env.TG_BOT_TOKEN
    const chatId = process.env.TG_CHAT_ID
    if (!botToken || !chatId) {
        console.warn('Telegram bot token or chat id not set, skipping notification.')
        return
    }
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            })
        })
        if (!res.ok) {
            console.error(`Failed to send Telegram message: ${res.status} ${res.statusText}`);
        }
    } catch (error) {
        console.error('Error sending Telegram message:', error);
    }
}

/**
 * Uploads a local file to a WebDAV server and returns a status message.
 * @returns {Promise<string>} A status message for the notification.
 */
async function uploadToWebDAV(localFile, remoteFile) {
    const webdavUrl = process.env.WEBDAV_URL
    const webdavUser = process.env.WEBDAV_USERNAME
    const webdavPass = process.env.WEBDAV_PASSWORD
    if (!webdavUrl || !webdavUser || !webdavPass) {
        console.log('WebDAV is not configured, skipping upload.')
        return '' // Return empty if not configured
    }

    const webdavSavePath = process.env.WEBDAV_SAVE_PATH || ''
    const remoteDir = webdavSavePath.replace(/\/$/, '')
    const fullRemotePath = remoteDir ? `${remoteDir}/${remoteFile}` : remoteFile
    const url = `${webdavUrl.replace(/\/$/, '')}/${fullRemotePath}`
    
    try {
        const fileStream = fs.createReadStream(localFile)
        const stat = fs.statSync(localFile)
        const basicAuth = Buffer.from(`${webdavUser}:${webdavPass}`).toString('base64')

        const res = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Length': stat.size, 'Authorization': `Basic ${basicAuth}` },
            body: fileStream
        })

        if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`)
        
        console.log('WebDAV upload successful:', url)
        return `✅ 录屏已成功上传到 WebDAV。\n路径: \`${fullRemotePath}\``
    } catch (error) {
        console.error('WebDAV upload error:', error.message)
        return `❌ WebDAV 上传失败: \`${error.message}\``
    }
}

/**
 * 获取当前页面所有th/td调试信息，并提取“利用期限”日期
 */
async function getExpirationDate(page) {
    try {
        const thTdList = await page.evaluate(() => {
            const results = [];
            const ths = Array.from(document.querySelectorAll('th'));
            ths.forEach(th => {
                let td = th.nextElementSibling;
                while (td && td.tagName !== 'TD') {
                    td = td.nextElementSibling;
                }
                results.push({
                    th: th.textContent.trim(),
                    td: td ? td.textContent.trim() : '无'
                });
            });
            return results;
        });

        for (const item of thTdList) {
            if (item.th === '利用期限') {
                const tdStr = item.td.replace(/\s/g, '');
                const match = tdStr.match(/\d{4}年\d{1,2}月\d{1,2}日/);
                return match ? match[0] : item.td;
            }
        }
        return '';
    } catch (error) {
        console.error("Could not evaluate getExpirationDate:", error);
        return '';
    }
}

/**
 * 尝试通过 JavaScript 直接调用 Turnstile 回调函数
 */
async function tryDirectTurnstileCallback(page) {
    try {
        const result = await page.evaluate(() => {
            // 尝试查找并调用 callbackTurnstile 函数
            if (typeof window.callbackTurnstile === 'function') {
                console.log('找到 callbackTurnstile 函数，尝试直接调用');
                window.callbackTurnstile('success');
                return { success: true, method: 'callbackTurnstile' };
            }
            
            // 查找 Turnstile 相关的全局变量
            const turnstileElements = document.querySelectorAll('[data-callback="callbackTurnstile"]');
            if (turnstileElements.length > 0) {
                console.log('找到带有 data-callback 的元素');
                return { success: true, method: 'data-callback', count: turnstileElements.length };
            }
            
            return { success: false, reason: 'No Turnstile callback found' };
        });
        
        console.log('直接回调尝试结果:', result);
        return result.success;
    } catch (error) {
        console.warn('直接调用 Turnstile 回调失败:', error.message);
        return false;
    }
}

/**
 * 保存详细的 iframe 调试信息
 */
async function saveIframeDebugInfo(page, frameIndex = 0) {
    try {
        const frames = page.frames();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            try {
                // 获取 iframe 基本信息
                const frameInfo = {
                    url: frame.url(),
                    name: frame.name(),
                    parentFrame: frame.parentFrame() ? frame.parentFrame().url() : 'main'
                };
                
                // 获取 iframe 内容
                const frameContent = await frame.content();
                
                // 尝试获取 iframe 内的所有可点击元素
                const clickableElements = await frame.evaluate(() => {
                    const elements = [];
                    const selectors = [
                        'input[type="checkbox"]',
                        'button',
                        '.checkbox',
                        '.cb-lb',
                        '.ctp-checkbox',
                        '.ctp-checkbox-label',
                        '.cf-turnstile-wrapper',
                        '[role="checkbox"]',
                        '[tabindex]',
                        'div[onclick]',
                        'span[onclick]'
                    ];
                    
                    selectors.forEach(selector => {
                        const found = document.querySelectorAll(selector);
                        found.forEach((el, idx) => {
                            elements.push({
                                selector,
                                index: idx,
                                tagName: el.tagName,
                                className: el.className,
                                id: el.id,
                                textContent: el.textContent?.trim().substring(0, 100),
                                attributes: Array.from(el.attributes).map(attr => ({
                                    name: attr.name,
                                    value: attr.value
                                })),
                                boundingRect: el.getBoundingClientRect(),
                                visible: el.offsetWidth > 0 && el.offsetHeight > 0
                            });
                        });
                    });
                    
                    return elements;
                }).catch(() => []);
                
                // 保存详细信息
                const debugInfo = {
                    frameInfo,
                    clickableElements,
                    frameContent
                };
                
                fs.writeFileSync(`turnstile_debug_frame_${i}_${timestamp}.json`, JSON.stringify(debugInfo, null, 2));
                fs.writeFileSync(`turnstile_debug_frame_${i}_${timestamp}.html`, frameContent);
                
                console.log(`保存 frame ${i} 调试信息: ${frame.url()}, 找到 ${clickableElements.length} 个可能的可点击元素`);
                
            } catch (frameError) {
                console.warn(`无法获取 frame ${i} 详细信息:`, frameError.message);
            }
        }
    } catch (error) {
        console.warn('保存 iframe 调试信息失败:', error.message);
    }
}

/**
 * 检测 Turnstile 验证是否成功
 */
async function detectTurnstileSuccess(page) {
    try {
        // 方法1: 检查页面中是否有成功标识
        const hasSuccessIndicator = await page.evaluate(() => {
            // 检查常见的成功标识
            const successSelectors = [
                '.cf-turnstile-success',
                '[data-cf-turnstile-success]',
                '.turnstile-success'
            ];
            
            for (const selector of successSelectors) {
                if (document.querySelector(selector)) {
                    return true;
                }
            }
            
            // 检查是否有 Turnstile token
            const inputs = document.querySelectorAll('input[name*="turnstile"], input[name*="cf-turnstile"]');
            for (const input of inputs) {
                if (input.value && input.value.length > 10) {
                    return true;
                }
            }
            
            return false;
        });
        
        if (hasSuccessIndicator) {
            console.log('检测到 Turnstile 验证成功标识');
            return true;
        }
        
        // 方法2: 检查 iframe 中的状态
        const frames = page.frames();
        for (const frame of frames) {
            if (frame.url().includes('challenges.cloudflare.com') || frame.url().includes('turnstile')) {
                try {
                    const frameSuccess = await frame.evaluate(() => {
                        const successElements = document.querySelectorAll('[aria-checked="true"], .success, .completed');
                        return successElements.length > 0;
                    });
                    
                    if (frameSuccess) {
                        console.log('在 Turnstile iframe 中检测到成功状态');
                        return true;
                    }
                } catch (frameError) {
                    // 忽略 iframe 访问错误
                }
            }
        }
        
        return false;
    } catch (error) {
        console.warn('检测 Turnstile 成功状态时出错:', error.message);
        return false;
    }
}

/**
 * 增强的 Turnstile 验证处理函数
 */
async function handleTurnstileVerification(page, maxAttempts = 5) {
    console.log('开始增强的 Turnstile 验证处理...');
    
    // 策略1: 尝试直接调用回调函数
    console.log('策略1: 尝试直接调用 JavaScript 回调函数');
    const directCallbackSuccess = await tryDirectTurnstileCallback(page);
    if (directCallbackSuccess) {
        await setTimeout(2000);
        const isSuccess = await detectTurnstileSuccess(page);
        if (isSuccess) {
            console.log('直接回调方法成功');
            return true;
        }
    }
    
    // 策略2: 增强的 iframe 处理
    console.log('策略2: 增强的 iframe 和元素检测');
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`Turnstile 处理尝试 ${attempt}/${maxAttempts}`);
        
        await setTimeout(1000 * attempt); // 递增延迟
        
        // 首先检查主页面是否有 Turnstile 元素
        const mainPageSelectors = [
            '[data-sitekey*="0x4AAAAAABlb1fIlWBrSDU3B"]',
            '[data-sitekey^="0x4"]',
            '[data-callback="callbackTurnstile"]',
            '.cf-turnstile',
            '.cloudflare-turnstile'
        ];
        
        for (const selector of mainPageSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    console.log(`在主页面找到 Turnstile 元素: ${selector}`);
                    
                    // 尝试不同的点击方法
                    const clickMethods = [
                        () => page.click(selector),
                        () => element.click(),
                        () => page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            if (el) {
                                el.click();
                                return true;
                            }
                            return false;
                        }, selector)
                    ];
                    
                    for (let i = 0; i < clickMethods.length; i++) {
                        try {
                            await clickMethods[i]();
                            console.log(`主页面元素点击成功 (方法 ${i + 1})`);
                            await setTimeout(3000);
                            
                            const isSuccess = await detectTurnstileSuccess(page);
                            if (isSuccess) {
                                console.log('主页面 Turnstile 验证成功');
                                return true;
                            }
                            break;
                        } catch (clickError) {
                            console.warn(`主页面元素点击方法 ${i + 1} 失败:`, clickError.message);
                        }
                    }
                }
            } catch (error) {
                console.log(`主页面选择器 ${selector} 未找到元素`);
            }
        }
        
        // 查找和处理 iframe
        const turnstileFrames = page.frames().filter(f => 
            f.url().includes('challenges.cloudflare.com') || 
            f.url().includes('turnstile') ||
            f.url().includes('cf-chl-widget') ||
            f.url().includes('cloudflare.com')
        );
        
        if (turnstileFrames.length > 0) {
            console.log(`找到 ${turnstileFrames.length} 个 Turnstile iframe`);
            
            for (const frame of turnstileFrames) {
                console.log(`处理 iframe: ${frame.url()}`);
                
                // 等待 iframe 加载
                await setTimeout(2000);
                
                // 扩展的选择器列表
                const iframeSelectors = [
                    'input[type="checkbox"]',
                    '.ctp-checkbox-label',
                    '.cf-turnstile-wrapper',
                    '.cb-lb',
                    '.ctp-checkbox',
                    '[role="checkbox"]',
                    'button',
                    '.checkbox',
                    '.challenge-checkbox',
                    'div[tabindex="0"]',
                    'span[tabindex="0"]',
                    '[aria-label*="checkbox"]',
                    '[aria-label*="验证"]',
                    '[aria-label*="verify"]'
                ];
                
                for (const selector of iframeSelectors) {
                    try {
                        // 等待元素出现
                        await frame.waitForSelector(selector, { timeout: 3000 });
                        
                        // 尝试不同的点击方法
                        const clickMethods = [
                            () => frame.click(selector),
                            () => frame.evaluate((sel) => {
                                const el = document.querySelector(sel);
                                if (el && typeof el.click === 'function') {
                                    el.click();
                                    return true;
                                }
                                return false;
                            }, selector),
                            () => frame.evaluate((sel) => {
                                const el = document.querySelector(sel);
                                if (el) {
                                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                                    return true;
                                }
                                return false;
                            }, selector)
                        ];
                        
                        for (let i = 0; i < clickMethods.length; i++) {
                            try {
                                const clickResult = await clickMethods[i]();
                                console.log(`iframe 点击成功 (选择器: ${selector}, 方法: ${i + 1})`);
                                await setTimeout(3000);
                                
                                const isSuccess = await detectTurnstileSuccess(page);
                                if (isSuccess) {
                                    console.log('iframe Turnstile 验证成功');
                                    return true;
                                }
                                break;
                            } catch (clickError) {
                                console.warn(`iframe 点击方法 ${i + 1} 失败:`, clickError.message);
                            }
                        }
                        
                        break; // 如果找到了元素，就不再尝试其他选择器
                    } catch (selectorError) {
                        console.log(`iframe 选择器 ${selector} 未找到或超时`);
                    }
                }
            }
        } else {
            console.log('未找到 Turnstile iframe');
        }
        
        // 在最后一次尝试时保存调试信息
        if (attempt === maxAttempts) {
            console.log('保存最终调试信息...');
            await saveIframeDebugInfo(page);
        }
        
        // 检查是否可能不需要验证码
        const hasOtherCaptcha = await page.$('img[src^="data:"]');
        if (!hasOtherCaptcha && attempt >= 3) {
            console.log('未找到其他验证码，可能不需要 Turnstile 验证');
            return true; // 假设不需要验证
        }
    }
    
    console.warn(`Turnstile 验证处理失败，已尝试 ${maxAttempts} 次`);
    return false;
}

// 生成北京时间字符串，格式 "YYYY-MM-DD HH:mm"
function getBeijingTimeString() {
    const dt = new Date(Date.now() + 8 * 60 * 60 * 1000); // UTC+8
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

// --- Main Script ---

const args = ['--no-sandbox', '--disable-setuid-sandbox']
if (process.env.PROXY_SERVER) {
    const proxy_url = new URL(process.env.PROXY_SERVER)
    proxy_url.username = ''
    proxy_url.password = ''
    args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''))
}

const browser = await puppeteer.launch({
    defaultViewport: { width: 1280, height: 1024 },
    args,
})
const page = await browser.newPage();

await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

page.on('console', msg => console.log('PAGE LOG:', msg.text()));
page.on('pageerror', error => console.log('PAGE ERROR:', error));

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER)
        if (username && password) {
            await page.authenticate({ username, password })
        }
    }
} catch (e) {
    console.error('代理认证配置出错:', e)
}

const recordingPath = 'recording.webm'
const recorder = await page.screencast({ path: recordingPath })

let lastExpireDate = ''
const expireDateFile = 'expire.txt'
let infoMessage = ''
let scriptErrorMessage = ''

try {
    if (fs.existsSync(expireDateFile)) {
        lastExpireDate = fs.readFileSync(expireDateFile, 'utf8').trim()
    }

    console.log('Navigating and logging in...')
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xserver/', { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.locator('text=ログインする').click()
    ]);

    console.log('Navigating to VPS panel...')
    await page.goto('https://secure.xserver.ne.jp/xapanel/xvps/index', { waitUntil: 'networkidle2' })

    console.log('Starting renewal process...')
    await page.locator('.contract__menuIcon').click();
    await page.locator('text=契約情報').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    await page.waitForSelector('th', {timeout: 10000});
    await setTimeout(5000);
    
    // 只取一次到期日，整个流程复用
    const currentExpireDateRaw = await getExpirationDate(page);
    const currentExpireDate = formatChineseDate(currentExpireDateRaw);

    await page.locator('text=更新する').click();
    await setTimeout(3000);
    await page.locator('text=引き続き無料VPSの利用を継続する').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 验证码处理（最多尝试 maxCaptchaTries 次，自动刷新并截图失败）
    const maxCaptchaTries = 3;
    let solved = false;

    // 使用增强的 Turnstile 验证处理
    console.log('开始处理 Cloudflare Turnstile 验证...');
    const turnstileHandled = await handleTurnstileVerification(page, 5);
    
    if (turnstileHandled) {
        console.log('Turnstile处理完成，等待验证结果...');
        await setTimeout(3000); // 等待验证处理完成
    } else {
        console.warn('Turnstile验证处理失败，但继续执行后续流程');
    }
    
    for (let attempt = 1; attempt <= maxCaptchaTries; attempt++) {
        const captchaImg = await page.$('img[src^="data:"]');
        if (!captchaImg) {
            console.log('无验证码，跳过验证码填写');
            fs.writeFileSync('no_captcha.html', await page.content());
            solved = true;
            break;
        }
    
        const base64 = await captchaImg.evaluate(img => img.src);
        let code = '';
        try {
            code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
                method: 'POST',
                body: base64,
            }).then(r => r.text());
        } catch (err) {
            console.warn(`验证码识别接口失败 (第 ${attempt} 次):`, err);
            await captchaImg.screenshot({ path: `captcha_failed_${attempt}.png` });
            continue;
        }
    
        if (!code || code.length < 4) {
            console.warn(`验证码识别失败 (第 ${attempt} 次)`);
            await captchaImg.screenshot({ path: `captcha_failed_${attempt}.png` });
            continue;
        }
    
        await page.locator('[placeholder="上の画像的数字を入力"]').fill(code);
        const [nav] = await Promise.allSettled([
            page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle2' }),
            page.locator('text=無料VPSの利用を継続する').click(),
        ]);
    
        if (nav.status === 'fulfilled') {
            console.log(`验证码尝试成功 (第 ${attempt} 次)`);
            solved = true;
            break;
        }
    
        console.warn(`验证码尝试失败 (第 ${attempt} 次)，刷新重试...`);
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    }
    
    if (!solved) {
        throw new Error('验证码识别失败：尝试多次未成功');
    }
    
    const bodyText = await page.evaluate(() => document.body.innerText);
    const notYetTimeMessage = bodyText.includes('利用期限の1日前から更新手続きが可能です');

    let renewAvailableDate = '';
    if (notYetTimeMessage) {
        const match = bodyText.match(/(\d{4}年\d{1,2}月\d{1,2}日)以降にお試しください/);
        if (match) {
            renewAvailableDate = formatChineseDate(match[1]);
        }
        infoMessage = `🗓️ 未到续费时间\n\n网站提示需要到期前一天才能操作。\n可续期日期: \`${renewAvailableDate || '未知'}\`\n当前到期日: \`${currentExpireDate || '未知'}\`\n\n北京时间: ${getBeijingTimeString()}`;
        console.log(infoMessage);
        // 不立即发送，等待录屏上传后统一通知
    } else {
        console.log('Proceeding with the final renewal step...');
        await page.locator('text=無料VPSの利用を継続する').click()
        await page.waitForNavigation({ waitUntil: 'networkidle2' })
        console.log('Returned to panel after renewal.');

        // 续期后，回到契约信息页面（通过点击菜单）
        await page.goto('https://secure.xserver.ne.jp/xapanel/xvps/index', { waitUntil: 'networkidle2' });
        await page.locator('.contract__menuIcon').click();
        await page.locator('text=契約情報').click();
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        await page.waitForSelector('th', {timeout: 10000});
        await setTimeout(3000); // 稍作等待
        const newExpireDateRaw = await getExpirationDate(page);
        const newExpireDate = formatChineseDate(newExpireDateRaw);

        const nextRenewDate = getNextRenewAvailableDate(newExpireDate);

        if (newExpireDate && newExpireDate !== formatChineseDate(lastExpireDate)) {
            const successMessage = `🎉 VPS 续费成功！

- 新到期日: \`${newExpireDate || '无'}\`
- 下次可续期日期: \`${nextRenewDate}\`

北京时间: ${getBeijingTimeString()}`
            console.log(successMessage)
            infoMessage = successMessage;
            fs.writeFileSync(expireDateFile, newExpireDate)
        } else if (newExpireDate) {
            const failMessage = `⚠️ VPS 续费失败或未执行！\n\n到期日未发生变化，当前仍为: \`${newExpireDate}\`\n请检查录屏或日志确认续期流程是否正常。\n\n北京时间: ${getBeijingTimeString()}`
            console.warn(failMessage)
            infoMessage = failMessage;
        } else {
            throw new Error('无法找到 VPS 到期日。续期后未能定位到期日，脚本可能需要更新。');
        }
    }

} catch (e) {
    console.error('An error occurred during the renewal process:', e)
    scriptErrorMessage = `🚨 **VPS 续期脚本执行出错** 🚨\n\n错误信息: \`${e.message}\`\n\n北京时间: ${getBeijingTimeString()}`
} finally {
    console.log('Script finished. Closing browser and saving recording.')
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()

    let finalNotification = ''
    let webdavMessage = ''
    let turnstileDebugMessage = ''

    // 录屏上传
    if (fs.existsSync(recordingPath)) {
        const timestamp = getBeijingTimeString().replace(/[\s:]/g, '-');
        const remoteFileName = `vps-renewal_${timestamp}.webm`
        webdavMessage = await uploadToWebDAV(recordingPath, remoteFileName)
    }

    // 增强的 turnstile debug 文件上传
    let allDebugMessages = [];
    
    // 上传传统的 debug html 文件
    if (fs.existsSync('turnstile_debug.html')) {
        const timestamp = getBeijingTimeString().replace(/[\s:]/g, '-');
        const remoteDebugFileName = `turnstile_debug_${timestamp}.html`;
        const debugMessage = await uploadToWebDAV('turnstile_debug.html', remoteDebugFileName);
        if (debugMessage) allDebugMessages.push(debugMessage);
    }
    
    // 上传详细的 frame debug 文件 (JSON 和 HTML)
    const debugFiles = fs.readdirSync('.').filter(file => 
        file.startsWith('turnstile_debug_frame_') && 
        (file.endsWith('.json') || file.endsWith('.html'))
    );
    
    for (const debugFile of debugFiles) {
        try {
            const timestamp = getBeijingTimeString().replace(/[\s:]/g, '-');
            const extension = debugFile.split('.').pop();
            const remoteDebugFileName = `enhanced_${debugFile.replace(/\.[^.]*$/, '')}_${timestamp}.${extension}`;
            const debugMessage = await uploadToWebDAV(debugFile, remoteDebugFileName);
            if (debugMessage) {
                allDebugMessages.push(`📁 增强调试文件: \`${remoteDebugFileName}\``);
            }
        } catch (uploadError) {
            console.warn(`上传调试文件 ${debugFile} 失败:`, uploadError.message);
        }
    }
    
    // 合并所有调试信息
    turnstileDebugMessage = allDebugMessages.length > 0 ? 
        `🔍 **调试文件已上传** (${allDebugMessages.length} 个文件)\n${allDebugMessages.join('\n')}` : 
        '';

    // 合并最终通知消息
    if (scriptErrorMessage) {
        finalNotification = scriptErrorMessage;
        if (webdavMessage) {
            finalNotification += `\n\n---\n${webdavMessage}`;
        }
        if (turnstileDebugMessage) {
            finalNotification += `\n\n---\n${turnstileDebugMessage}`;
        }
    } else if (infoMessage) {
        finalNotification = infoMessage;
        if (webdavMessage) {
            finalNotification += `\n\n---\n${webdavMessage}`;
        }
        if (turnstileDebugMessage) {
            finalNotification += `\n\n---\n${turnstileDebugMessage}`;
        }
    } else if (webdavMessage || turnstileDebugMessage) {
        finalNotification = webdavMessage;
        if (turnstileDebugMessage) {
            finalNotification += finalNotification ? `\n\n---\n${turnstileDebugMessage}` : turnstileDebugMessage;
        }
    }

    if (finalNotification) {
        await sendTelegramMessage(finalNotification);
    }
}
