import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import { Rate } from 'k6/metrics';

export const options = {
    thresholds: {
        http_req_failed: ['rate<0.01'], // less than 1% of requests should fail
    },
    stages: [
        { duration: '1m', target: 100 }, // ramp-up to 100 VUs
        { duration: '2m', target: 100 }, // continue at 100 VUs
        { duration: '1m', target: 0 }, // ramp-down to 0 VUs
    ],
};

const url = 'http://localhost:3112/v1/exec';
const rate = new Rate('requests_per_second');

const basePayload = {
    lang: 'py',
    code: 'import matplotlib.pyplot as plt\nimport numpy as np\n\n# Original signal generation\nx = np.linspace(0, 2 * np.pi, 100)\ny = np.sin(x)\n\n# Create and save the original sine wave plot\nplt.figure()\nplt.plot(x, y)\nplt.title("Original Sine Wave")\nplt.savefig("./sine_wave.png")\nplt.close()\n\n# Modify the plot data\ny_modified = y * 1.5  # Amplify the sine wave\n\n# Create a new plot with the modified data\nplt.figure()\nplt.plot(x, y_modified)\nplt.title("Modified Sine Wave")\nplt.savefig("./modified_sine_wave.png")\nplt.close()\nprint("Modified plot saved as modified_sine_wave.png")\n\n# Read and modify the original image\noriginal_img = plt.imread("./sine_wave.png")\nmodified_img = original_img * [1, 0.8, 0.8, 1]  # Reduce green and blue channels\n\nplt.figure()\nplt.imshow(modified_img)\nplt.axis(\'off\')\nplt.savefig("./tinted_sine_wave.png")\nplt.close()\nprint("Tinted original plot saved as tinted_sine_wave.png")\n\nprint("\\nScript completed successfully")',
};

export default function () {
    const session_id = `session_${randomString(8)}`;
    const user_id = `user_${randomString(8)}`;

    const randomizedPayload = JSON.parse(JSON.stringify(basePayload));
    randomizedPayload.session_id = session_id;
    randomizedPayload.user_id = user_id;

    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${__ENV.CODEAPI_BEARER_TOKEN ?? ''}`,
    };

    const response = http.post(url, JSON.stringify(randomizedPayload), {
        headers,
    });

    check(response, {
        'status is 200': r => r.status === 200,
    });

    rate.add(1);
}
