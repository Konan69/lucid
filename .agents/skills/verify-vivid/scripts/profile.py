"""Configure only the generated test binary for its disposable loopback server and embedded JS."""
from pathlib import Path
import sys
import xml.etree.ElementTree as XML

root = Path(sys.argv[1]).resolve()
assert root.is_relative_to(Path.home() / '.cache/vivid-android/source'), 'Refuse product checkout'
android = '{http://schemas.android.com/apk/res/android}'
XML.register_namespace('android', 'http://schemas.android.com/apk/res/android')
XML.register_namespace('tools', 'http://schemas.android.com/tools')
manifest = root / 'android/app/src/main/AndroidManifest.xml'
tree = XML.parse(manifest)
app = tree.getroot().find('application')
assert app is not None, 'Generated manifest has no application'
app.set(android + 'networkSecurityConfig', '@xml/verify_network')
for entry in app.findall('meta-data'):
    if entry.get(android + 'name') == 'expo.modules.updates.ENABLED':
        entry.set(android + 'value', 'false')
tree.write(manifest, encoding='utf-8', xml_declaration=True)
resource = root / 'android/app/src/main/res/xml/verify_network.xml'
resource.parent.mkdir(parents=True, exist_ok=True)
resource.write_text('''<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
''')
