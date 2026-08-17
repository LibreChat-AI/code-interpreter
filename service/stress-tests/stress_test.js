import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import { Rate } from 'k6/metrics';

export const options = {
    vus: 50, // Increased number of VUs
    duration: '1m',
    rps: 17, // Target 17 requests per second (1020 per minute)
};

const url = 'https://api.librechat.ai/v1/exec';
// const url = 'http://localhost:3112/v1/exec';
const rate = new Rate('requests_per_second');

const basePayload = {
    language: 'py',
    code: `import matplotlib.pyplot as plt
import numpy as np

# Original signal generation
x = np.linspace(0, 2 * np.pi, 100)
y = np.sin(x)

# Create and save the original sine wave plot
plt.figure()
plt.plot(x, y)
plt.title("Original Sine Wave")
plt.savefig("./sine_wave.png")
plt.close()

# Modify the plot data
y_modified = y * 1.5  # Amplify the sine wave

# Create a new plot with the modified data
plt.figure()
plt.plot(x, y_modified)
plt.title("Modified Sine Wave")
plt.savefig("./modified_sine_wave.png")
plt.close()
print("Modified plot saved as modified_sine_wave.png")

# Read and modify the original image
original_img = plt.imread("./sine_wave.png")
modified_img = original_img * [1, 0.8, 0.8, 1]  # Reduce green and blue channels

plt.figure()
plt.imshow(modified_img)
plt.axis('off')
plt.savefig("./tinted_sine_wave.png")
plt.close()
print("Tinted original plot saved as tinted_sine_wave.png")

print("\\nScript completed successfully")`,
};

export default function () {
    const session_id = `session_${randomString(8)}`;
    const user_id = `user_${randomString(8)}`;

    const randomizedPayload = JSON.parse(JSON.stringify(basePayload));
    randomizedPayload.session_id = session_id;
    randomizedPayload.user_id = user_id;

    const headers = {
        'Content-Type': 'application/json',
    };

    const response = http.post(url, JSON.stringify(randomizedPayload), {
        headers: headers,
    });

    check(response, {
        'status is 200': r => r.status === 200,
    });

    rate.add(1);
}
