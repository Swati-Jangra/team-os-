const net=require('net');let n=0;
net.createServer(s=>{s.write('220 sink\r\n');let data=false,buf='';
s.on('data',d=>{buf+=d;if(data){if(buf.includes('\r\n.\r\n')){data=false;buf='';n++;console.log('MAIL',n);s.write('250 ok\r\n');}return;}
for(const l of buf.split('\r\n').filter(Boolean)){const u=l.toUpperCase();if(u.startsWith('DATA')){data=true;s.write('354 go\r\n');buf='';return}
if(u.startsWith('QUIT')){s.write('221 bye\r\n');s.end();return}
if(u.startsWith('EHLO')||u.startsWith('HELO'))s.write('250 sink\r\n');else s.write('250 ok\r\n')}
if(!data)buf='';});}).listen(1025,()=>console.log('sink up'));
