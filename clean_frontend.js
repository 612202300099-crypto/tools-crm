const fs = require('fs');
const path = 'c:/Users/Lenovo/Documents/tools-crm/frontend/src/app/dashboard/[customerId]/page.tsx';
let content = fs.readFileSync(path, 'utf8');
const startMarker = 'window.location.href = downloadUrl;\r\n    window.location.href = downloadUrl;\r\n  };\r\n\r\n\r\n    try {';
// Wait, I don't know if it's \r\n or \n.
// Let's use a regex.
const regex = /\n\n\n\s+try \{[\s\S]+?finally \{[\s\S]+?\}[\s\n]+?\};/m;
const newContent = content.replace(regex, '\n  };');
fs.writeFileSync(path, newContent);
console.log('Cleanup done');
