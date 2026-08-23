const { TelegramClient } = require('telegram')
const { StringSession } = require('telegram/sessions')
const input = require('input')

const TG_API_ID   = parseInt(process.env.TG_API_ID   || '0')
const TG_API_HASH = process.env.TG_API_HASH           || ''

;(async () => {
  const session = new StringSession('')
  const client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
    connectionRetries: 5,
  })

  await client.start({
    phoneNumber: async () => await input.text('Số điện thoại (+84...): '),
    password: async () => await input.text('Mật khẩu 2FA (nếu có, bỏ trống nếu không): '),
    phoneCode: async () => await input.text('Mã OTP Telegram: '),
    onError: (err) => console.error(err),
  })

  console.log('\n✅ TG_SESSION mới:')
  console.log(client.session.save())
  await client.disconnect()
})()
