import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import session from 'express-session';
import OpenAI from 'openai';
import axios from 'axios';
import { createCanvas, loadImage } from 'canvas';
import config from './config';
import { StoryClient, StoryConfig } from '@story-protocol/core-sdk'
import { Address, http,ContractFunctionExecutionError} from 'viem'
import { S3 } from 'aws-sdk';
import { Account, privateKeyToAccount} from 'viem/accounts';
import { ethers } from 'ethers';
import MemeNFT from '../artifacts/contracts/Meme.sol/Meme.json';

const app = express();
const port = 5000;
const openai = new OpenAI({apiKey: config.OPENAI_API_KEY});
const RPCProviderUrl ='https://devnet.neonevm.org'
const provider = new ethers.providers.JsonRpcProvider(RPCProviderUrl);
const contractAddress = '0x4B72dc1Ca2Aa8D36e2022Ea4Ded348B818D8c664'; // The deployed contract address
const memeContract = new ethers.Contract(contractAddress, MemeNFT.abi, provider);

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({ secret: 'thisisasecret', resave: false, saveUninitialized: true }));

app.get('/', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});
// Route to serve the publish page
app.get('/publish', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'publish.html'));
});

// Save image with BigNumber filename
app.post('/saveImage', (req: Request, res: Response) => {
  try {
    const { image } = req.body;

    if (!image) {
      throw new Error('Image data is missing in the request body.');
    }

    const base64Data = image.replace(/^data:image\/png;base64,/, '');
    const imageData = Buffer.from(base64Data, 'base64');

    // Generate a BigNumber as the filename
    const bigNumberFilename = ethers.BigNumber.from(ethers.utils.randomBytes(32)).toString();
    // Use the BigNumber as the filename
    console.log(bigNumberFilename)
    const filename = `public/mask/masked_image_${bigNumberFilename}.png`;
    const savePath = filename;

    fs.writeFile(savePath, imageData, (err) => {
      if (err) {
        console.error('Error saving image:', err);
        return res.status(500).json({ error: 'Error saving image.' });
      }

      req.session.mask_image = savePath;

      const savedImageUrl = `/${filename}`;
      return res.status(200).json({ message: 'Image saved successfully.', imageUrl: savedImageUrl });
    });
  } catch (err) {
    console.error('Error in /saveImage route:', err);
    return res.status(500).json({ error: 'Internal Server Error.' });
  }
});

app.post('/recreateImage', async (req: Request, res: Response) => {
  try {
    const { prompt } = req.body;
    const ori_image = req.session.ori_image;
    const mask_image = req.session.mask_image;

    if (!ori_image || !mask_image) {
      throw new Error('Original image or mask image is missing.');
    }

    const response = await openai.images.edit({
      model: 'dall-e-2',
      image: fs.createReadStream(ori_image),
      mask: fs.createReadStream(mask_image),
      prompt: prompt,
      n: 1,
      size: '256x256',
    });

    const image_url = response.data[0].url;

    if (!image_url) {
      throw new Error('Failed to get the image URL from the response.');
    }

    // Generate a BigNumber as the filename
    const bigNumberFilename = ethers.BigNumber.from(ethers.utils.randomBytes(32)).toString();
    const gen_image_filename = `${bigNumberFilename}.png`;
    const gen_image_path = `public/asset/${gen_image_filename}`;

    const imageResponse = await axios.get(image_url, { responseType: 'arraybuffer' });
    fs.writeFileSync(gen_image_path, imageResponse.data);

    const image = await loadImage(gen_image_path);
    const canvas = createCanvas(248, 248);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, 248, 248);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(gen_image_path, buffer);
    
    const bucketName = 'eclipse-challenge';
    const imagePath = gen_image_path; // Path to your local image file
    const keyName = `gen/${gen_image_filename}`; // Path in the S3 bucket

    uploadImageToS3(bucketName, imagePath, keyName)
        .then((s3ObjectUrl) => {
            console.log('Uploaded image URL:', s3ObjectUrl);
        })
        .catch((error) => {
            console.error('Failed to upload image:', error);
        });

        
    req.session.ori_image = gen_image_path;
    const gen_image_url = `asset/${gen_image_filename}`;
    res.json({ gen_image_url: gen_image_url, gen_image_filename: gen_image_filename  });
 
  } catch (err) {
    if (err instanceof Error) {
      console.error(err);
      res.status(500).json({ error: `Error recreating image: ${err.message}` });
    } else {
      console.error('Unexpected error', err);
      res.status(500).json({ error: 'Unexpected error' });
    }
  }
});


app.post('/setSession', (req: Request, res: Response) => {
  req.session.ori_image = 'public/image/chiikawa_rgba.png';
  console.log('Reset root image');
  if (req.session.mask_image) {
    delete req.session.mask_image;
    console.log('Mask image cleared');
  }
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

//mint NFT
app.post('/mintNFT', async (req: Request, res: Response) => {
  try {
    const { userAddress, customUri } = req.body;
    
    // if (!userAddress || !customUri) {
    //   return res.status(400).json({ error: 'User address or custom URI is missing.' });
    // }

    // Initialize the contract without a signer
    const provider = new ethers.providers.JsonRpcProvider(RPCProviderUrl);
    const contract = new ethers.Contract(contractAddress, MemeNFT.abi, provider);

    // Encode the transaction data
    const txData = contract.interface.encodeFunctionData('mintNFT', [userAddress, customUri]);

    // Estimate the gas cost for the transaction
    const gasEstimate = await contract.estimateGas.mintNFT(userAddress, customUri);

    // Prepare the transaction data to be sent to the client
    const tx = {
      to: contractAddress,
      from: userAddress,
      data: txData,
      gasLimit: ethers.utils.hexlify(gasEstimate),
      // Optionally, you can add more fields like gasPrice
    };

    // Send the transaction data to the client
    res.status(200).json(tx);
  } catch (error) {
    //console.log('Error preparing transaction:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});




///////////

// //Story Protocol
// app.post('/registerIP', async (req: Request, res: Response) => {
//   try {
//     console.log('Give up using account from provider. Try to use private key now.')
//     const privateKey: Address = `0x${process.env.WALLET_PRIVATE_KEY}`;
//     const account: Account = privateKeyToAccount(privateKey);

//     if(account){
//     const { IPid, derivativeTokenId } = req.body;
//     const config: StoryConfig = {
//       transport: http(RPCProviderUrl),
//       account: account, // the account address from above
//       chainId: 'sepolia'
//     };
//       console.log(`Start to mint liscense at account address: ${config.account}`);
//       console.log(`IPid: ${IPid}`)
//       console.log(`OwnerAddress: ${OwnerAddress}`)
//       const client = StoryClient.newClient(config);

//       const mintLicenseResponse = await client.license.mintLicenseTokens({
//         licenseTermsId: NonCommercialSocialRemixingTermsId,
//         licensorIpId: IPid,
//         receiver: OwnerAddress,
//         amount: 1,
//         txOptions: { waitForTransaction: true },
//       });

//       console.log(`License Token minted at transaction hash ${mintLicenseResponse.txHash}, License ID: ${mintLicenseResponse.licenseTokenId}`);

//       console.log(`Start to register IP asset`);
//       console.log(`TokenID: ${derivativeTokenId}`)
//       console.log(`Contract address: ${NFTContractAddress}`)
//       const registeredIpAssetDerivativeResponse = await client.ipAsset.register({
//         nftContract: NFTContractAddress,
//         tokenId: derivativeTokenId,
//         txOptions: { waitForTransaction: true },
//       });

//       console.log(`Derivative IPA created at transaction hash ${registeredIpAssetDerivativeResponse.txHash}, IPA ID: ${registeredIpAssetDerivativeResponse.ipId}`);

//       const linkDerivativeResponse = await client.ipAsset.registerDerivativeWithLicenseTokens({
//         childIpId: registeredIpAssetDerivativeResponse.ipId as Address,
//         licenseTokenIds: [mintLicenseResponse.licenseTokenId as bigint],
//         txOptions: { waitForTransaction: true },
//       });

//       console.log(`Derivative IPA linked to parent at transaction hash ${linkDerivativeResponse.txHash}`);
//     res.status(200).send('Ethereum logic executed successfully.');
//   }else{
//     console.log('No Wallet Address. IP asset register failed.')
//   }}  
//   catch (error) {
//     if (error instanceof ContractFunctionExecutionError) {
//       const cause = error.cause
//         .walk()
//         .message.split(":")[2]
//         .split("\n")[0]
//         .trim();
//       return sentenceCase(cause);
//     }
//     console.error('Error executing Ethereum logic:', error);
//     res.status(500).send('Internal Server Error');
//   }
// }
// );

// AWS S3 configuration
const s3 = new S3({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region 
});

// Function to upload an image to S3
async function uploadImageToS3(bucketName: string, imagePath: string, keyName: string): Promise<string> {
    try {
        // Read the image file
        const fileContent = fs.readFileSync(imagePath);

        // Set S3 upload parameters
        const params = {
            Bucket: bucketName,
            Key: keyName,
            Body: fileContent,
            ContentType: 'image/png', // Modify based on your file type
            ACL: 'public-read' // Set object ACL to public-read
        };

        // Upload file to S3
        const data = await s3.upload(params).promise();
        console.log('File uploaded successfully:', data.Location);

        return data.Location; // Return the S3 object URL
    } catch (error) {
        console.error('Error uploading file to S3:', error);
        throw error; // Rethrow the error for higher-level handling
    }
}

// Example configuration for custom transport (replace with actual implementation)
function custom(provider: any) {
  // Implement custom transport based on provider (MetaMask, etc.)
  return provider;
}

function sentenceCase(cause: string): void | PromiseLike<void> {
  throw new Error('Function not implemented.');
}

