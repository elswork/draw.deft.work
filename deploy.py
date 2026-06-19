import os
import base64
import urllib.request
import json
import subprocess

FILES_TO_DEPLOY = [
    "index.html",
    "app.js",
    "canvas-manager.js",
    "gesture-detector.js",
    "styles.css",
    "physics-manager.js"
]

M2_API = "http://192.168.1.75:5051/system/write-config"
M2_RUN_API = "http://192.168.1.75:5051/system/run"
M2_TARGET_DIR = "/host/home/pirate/docker/uwas-anticitera/www/draw.deft.work"
GCP_TARGET_DIR = "/home/pirate/www/draw.deft.work"
GCP_IP = "104.155.166.27"
SSH_KEY = "/home/pirate/.ssh/google_compute_engine"

def post_json(url, data):
    req = urllib.request.Request(url, data=json.dumps(data).encode('utf-8'), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode())
    except Exception as e:
        return {"error": str(e)}

def deploy_to_m2(filename, content):
    print(f"Deploying {filename} to M2...")
    payload = {
        "path": f"{M2_TARGET_DIR}/{filename}",
        "content": content
    }
    res = post_json(M2_API, payload)
    print("  M2 response:", res)

def deploy_to_gcp(filename, content):
    print(f"Deploying {filename} to GCP...")
    b64_content = base64.b64encode(content.encode('utf-8')).decode('utf-8')
    cmd = [
        "ssh", "-o", "StrictHostKeyChecking=no", "-i", SSH_KEY, f"pirate@{GCP_IP}",
        f"sudo mkdir -p {GCP_TARGET_DIR} && echo '{b64_content}' | base64 -d | sudo tee {GCP_TARGET_DIR}/{filename} > /dev/null"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        print(f"  GCP deploy success for {filename}")
    else:
        print(f"  GCP deploy failed for {filename}: {result.stderr}")

def main():
    post_json(M2_RUN_API, {"command": f"mkdir -p {M2_TARGET_DIR}"})

    for f in FILES_TO_DEPLOY:
        path = os.path.join("/home/pirate/docker/draw.deft.work", f)
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as file:
                content = file.read()
            deploy_to_m2(f, content)
            deploy_to_gcp(f, content)
        else:
            print(f"WARNING: File {f} not found locally.")

if __name__ == '__main__':
    main()
