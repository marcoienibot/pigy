/**
 * The key the simulated Google signs with. It is not a secret: it is public
 * in this repository, and nothing may trust it outside development and tests.
 * It is fixed rather than generated so that every Worker isolate signs and
 * verifies with the same key.
 */
export const signingKey = {
  kid: "simulated-google-key-1",
  alg: "RS256",
  use: "sig",
  kty: "RSA",
  n: "rD39SoCYwEfgQiZtui_aZgFZ7CrRwUp-zPvaUQ3wH6BD05XMJfsDpmLjf7FicIH-9ImHeeciMknY2Kv2Mcl22YPEsxiULXS-3KDev70HHtKnV-rqhM1F-ZMZmIOLeKE4Gs47kIKbgi6SwzxaID8jlAHlRp3Nu--kV-0jo9hP1DDt82mer3MRbU1jPdAPi8pl_6eZRFRuu70s1qnyMaNxGCeuh3FcWBf6NHExmVjUkUEH96_rav6ZGo3QoyuRcKkHt9ydDlcRrvvlX2VJD35er6wn2N90BPM7RFqbYluqhCOylzFzc_nZDcRoVIJqW50KMqPR91F4LSc0v7HiVD7gew",
  e: "AQAB",
  d: "FelyRlQYb_202IrYUrixFAuqoOd29RwWXYV8v0BYApik3aSk6qqwStkxupZFFlhd_ZtcEh9cCQG-sHHP9C1-YoA85HvaqJ29hNvXpT-ASbo1cnMpj-jStMQInDpqjSzAB8j3aD71Vu5jMACG3ACsSgajta7FntmxvUMnJuTnOEXRIrhwCGJP-kPAqIGUsZcLy0tgn0m2-Vrjz-qDebC5kcdKi8gecDPsdExXTXqsJUtd2YnvQ1lVWWhscCUu2XlX45rGCzdKzF-QZ1gmABNihmUVT04kQn4srqMkzboxIYDkv8IqZ0Ds12SCrDb68dODQHXyyQMn6b5UHCXBN-a6IQ",
  p: "16AVh1TWyrkQxIQMv1OjPaNE3IxAu0vxSFC2BUPdcdLvHeoH0j1CG3CtD0QWLi3OpZyh3XsOjUi0gIDnCCNzdp5_ZdehM6wwNkpdV87y7f0WGKabMkaTolPcEQe53oU3vLlCOLm-BxHrqxOB9O5wcy7yUQh2KgqT5nvThyEn-P8",
  q: "zH5Zc6YyOsXO-VGVN_eZF9S8HM5bzy6P64-LGJCgw6AVBMqHURshoW3jyxL_yRDilkf7ur98p6Lq8UxtbPie3U0H7WDMCTaYMrKs5AWB0j6ntrZbZsZyILaxHnMQNQRi8h8QHri9T8ihM6GR_Iu42__uUr5IYgEj5BzWC1shfIU",
  dp: "n54PkcjJ3_OzZ-XgkdlWJBCyrxjb6kpDaKbmt2sPiGz_OYO_GnDiePGmCoD6cmDScmJKqGup0AicJexGGg40MQEPidJfsKKsZeQSySeXSXlqXAEpLcR1EVtGswynGQRAyGHTla5Z713iuReNwkSn1XxRQI8k-eYuqhXL9mIi9v0",
  dq: "u8DWSISzYZr0qZzqMHS4r1S3Uot1aAgMQ--LeoZv1K1KHxgEnccXXawTlgRfrTA_mlOFILVnslK2-818Oq0az31GZgCV1W-21fWPH9yekXbNbciIqxhQ-RBEFvz2SHc6katLlalwx6whtdIGw6VVmUimfHoQ40rAtVR0ggCuAjE",
  qi: "vHWhfz-aMjzOQAjPuIEoO6X6dmzqZP5_N-0ooijMlmkfHwQY3bvfTWxhGPvaQfDcTo2mgcFLD1vnuNnL6TZ4pc0NSMAovejmYWWvDB5MvNb3wlcGyGF0tu1Sb5AS_oQl1k-VGPiPpIESHuE1KY3sWYTM5Dxj-SkVZR9rFPgJdeU",
} as const;
