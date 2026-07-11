// Papel timbrado Attentive para relatórios em PDF (cabeçalho com logo + rodapé).
// Gera uma janela de impressão (salvar como PDF) com o conteúdo passado.
export const HEADER_IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA70AAACbCAYAAACuwPwaAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAACSwSURBVHhe7Z2JuxxFvYbzX9x7RRJEFKKgCQENCLKpEQQM+74KaAAxbIIYQFYhiUjYEdmXgBAMYZNdQCKrEIEAAgFCAAERgbAoYN35arr71HRq5kzP1Jnqnnnf53kfPb3MOXNSxalvqurXo+bPn29W+uqmOEB+/iubmM+vOsl87ssbmhVWWc86euV1e+YYucq6te+L2L2jv/B1s9wKXzXLjVnVfGb0WPO/n/3iiPt/+l617/nZFSeY5b+wtredt5I+gKEc88Va+6tYH0jbP30AQ6j2v/xKa9g+0Kv2/z/Lr+odXyFieSX0DoArrraxDbhjxq5f+wNBwMXqGmNwkx/cM8DHmNqAu+L4qAG3SB+w7V963gtiUWP8DfjM6C+b5T43rtaO1zGf+9JGZsVVJ3nHWohYbgm9faYCrmZxYwZcBjcYwigBd/mxdoCvwf1nV5pIwMWoxuoDIT7k8b0fxCLm23+v+oAC7ujaf/8JuIj9JaG3wqYBN12m7BuAjJR8eo8hjTW4UcBdboVxnQdc6Xk/iEWtbB/wvBfEosZapq+A+9nPr1Fry+sQcBH7XEJvRcwH3F6GXAb3GFINbmIN7tmHi2Wwin0gbf/0AQyhDbg9XqafD7iEXMTBktBbQik0hf1kjMFNfnDPDBbGNMYMFgEXy2J+FYOvvYZW+3AJuIjoSugtgbbQ1KrfYh8uVt4Yg5tQexDpAxjCKH1gTOcf8tj2Lz3vBbGo+fbfqz5AoSlEHE5Cb4+Nvg+39keJwQ2GMMbgXmqAr8E9+3AxtrE+5Om6D3jeC2JRYy3TT5cpE3ARsYiE3hGUQlPYL8b69F6DewpNYRmsbB/wvBfETlQfUPun0BQiVlFCbyApNIX9Yqwqmvklmr623kr6AIayin0gbf/0AQyhbf8UmkLEPpLQ24FuoamY+3B9f6gQixpjcJMf3DPAx5hWrQ/Y9i897wWxqGr/vV6mT6EpROy1hN42pNAU9osxBjcUmsIyWbU+QMDFkObbf6/6gGZxR680kX24iBhNQm9OCk1hvxhjcC81g6XBPftwMbaxBvhd9wHPe0EsauxCU+zDRcQyOdChl0JT2C/GHNx3ugdR0gcwlLEG+Fkf6CLg0gcwhPo7oPYfcx+ub6yFiFgGByb0xiw0JRncYygpNIVYa1MV6wMEXAxp/oNOX3sNLYWmELHK9mXoVaEpuw+XQlPYB9rBPYWmcICtWh+w7V963gtiUWMEXBWaUshVwGUfLiL2g30Reik0hf1ijMENhaawTFa5D/jeD2IR8+2/V32AQlOI2O9WLvRSaAr7xViDG81gLbfCOApNYXQr2wc87wWxqLG2qrAPFxEH0VKH3pj7cBncY0ijF9npYA+ipA9gKKvYB9L2Tx/AENqA2+Nl+uzDRUSsW5rQq324FJrCfjHGp/cEXCyTMQb4BFwsi/lVDL72GlrtwyXgIiL6jRZ6KTSF/WIZBvcM8DGmMQb43fQB2/6l570gFjXf/nvVByg0hf3g1MOmm/ff/9AsXfqBuee+R8wqEybb418cv5m57/5H7fF33l1qDvrZzOyebXY5xLy39H17buHTz5sJ626fnUNsZk9CL4WmsF+MMrh3iuywDxdjG6sPKOR21Qc87wWxqLGW6afLlAm42G+utdGu5rW/v2lSDp12SnbuyOPPTI4as/jl17Jwu9rErc2CJ/6WnDHm9HNmZ/cgNjN46I1eaEp6/lAhFjXWp/ca3FNoCstgZfuA570gdqL6gNo/haYQw6nQuu6k3bOvf37M6Ul8rYfb1dfZzh4fu8Zk89hfn07ONIbbXfeZZj759FN7/N33lpqNNt07O4fos6vQS6Ep7BcpNIWDbqxKst30gbT90wcwhLb9U2gKccQ967yrzKIXltjwq68Vbhc8/owNsOK0s6/IrnXDrZY5b+iE25tuvdceF3NvuDM7juiz7dBLoSnsJ6s2uJcM8DGkMQb4+T5QpB/Y9i897wWxqGr/vV6mT6EpxE3tjKxmZsXM0y7Ojivcfvrpf+3xdsPtpMlT7H5g8cknn5jt9zgsO4eYt2nopdAU9osxBjfdDO4lARdDGqUPOHvRCbgY03z771Uf0Czu6JUmsg8X0VGhNeX6m+5uOHfzrX9KzrQfbs+94Gp7XDz0yBNm5dW/n51DdLWhN12mTKEprLqxBvcKuRrcsw8XYxtrgN91H/C8F8Sixi40xT5cxObusOfhNrQKhdjvbjGl4XyrcPubC6+xx4Ubbtdcb0fz6mtDhbAO+fmvsnsQXUf5BiAjJYN7DGnMwX2nRXYkfQBDWcW96Gn7pw9gCPV3QO2fQlOI5VYhVWE1RSHWd1274fbgI4bC7bRjz0iOGvPS4lezQliIriMWegm4GFIKTSHW2lSEAT4BF8tijJU8FJpCDKNmYFMUXhVidVxFrPY7+ESz8vjN7ddfW3+nwuH2S2tu0fAIo1lnX57dg5gaLPQyuMeQ2sF9hYrsSAb4GNJsgD+mGn3Atn/peS+IRY0RcFVoSiFXAZd9uIjhVDhVSE1ReE3P6bm8Yt8DT8iOTTtuKNy+WLtv/Df84fbUsy7L7tn9R0c2FMLa4Ht7ZecQZUehl8E9hjTG4KabIjuSAT6GNFYfUMhVH2AfLsY03/571QcoNIXYGzXzmqLQqvCq424Yfvb5xeYra9UfYdRpuP3DbffZ4+LaeXdkxxHlsKGXgIshjTG4l10P7qXn/SAWNdYAX32g073otH8MZaznQbMPFzGOCqUKp0JhVaE1PeeG4ScWPpc9t1e64fZf77zXEG5vud0fblUYKy2E9fHHH5vtd/9pdg6xIfQyuMeQVnFwL+kDGEoKTeGgawNuj7eqsA8XsTwqlKZoJjY93ioMp7rhds6827PjG2+5r/ngg6Fwu91uh2bnzrvoWntcPPDw4zzCCDNHMbDBEMb69L6bwb1kgI8hjTHAz/eBIv2A9o8hzX/Q6WuvodU+XAIuYjnVTKtCqcg/osgNwwq37n2pnYRbFcJ67e9DhbAO+tnM7B4cbEf5/nAhDmfVBveSAT6GNMYAv5u96Lb9S897QSxqvv33qg9QaAqxGiqEKoymKKSm5xRe0zCsUKtwm5475YxLzebbHZB93Szcfn2DxnB74OEzsnuOPP7M5KgxL7z0SlYICwdbQi8Oa9UG95IBPoY0Rh+Q+qBHfYB9uBjTWMv002XKBFzE6qkZ1hSFU83A6vhwYVjc/aeHG8Lt31//hz0u3HB71AlnJUcbw+2Xv7alefzJZ5Mzxvz6zKFCWDi4EnqxwcoO7qXn/SAWNdYMlvoAhaawDKoPqP1TaAoRO1HhUyE0RTOv6TmF1pRWYXiXvY/I7mk33GqWOL1nz32PbiiEtf4mP8jO4WBK6B1gYw7uQ+zD9b0nxCJWcS962v7pAxhC2/4pNIWIAdXMaopCqcKpjufDsMJseo8bhjWzu853ds/OtR1u//VuQ7i95Y759riYc91QISwcTAm9AyKFphBrbSrCAD/fB4r0A9v+pee9IBY1/0Gnr72GlkJTiIOlQqdmVoXCqEJpek5hNcUNw+PW3rZpGE7Nh9v1Nt4zO3frnX+2x8U1c2/Ljm+y1X4NhbC23XWoEBYOnoTePrVqg3tJwMWQxhjgU2gKy2K+/feqD2gWd/RKE9mHizigakY1RTOt6XEbhmthVbQbhvO2G2632eWQ7Nz5l/zeHhd/fnCBWXn85tk5HCwJvX1g1Qb3kgE+hjTWAF8f9LAPF2Mbu9AU+3ARUWom1a3KrDCanlNITVF4TY9rxrZZGM5rw+2HH9lr2w23+UJYUw+bnt2DgyWht2JWcXAvGeBjKGMN8LtZqp+2f/oAhlB/B2Lvw/UNKBBxcFXIVNhMUQhNz3UShpt5waVzk6sbw+3EDXc2r7/xVnKmMdwe7RTCWvTiErucOj2HgyOht8RWcXAvCbgYUjvAr7XHquxFJ+BiSGOs5KHQFCIWVSEzRTOrCqE63ioMa6Y2C8MffmS+t/X+2blmtgq3vzjx7ORoY7jVcuknFj6XnDHmV6dfkt2DgyOht0RWbXAvGeBjSGMM8PN9oEg/sO1fet4LYlFjtH8VmlLIVcBlHy4idqLCpUJmimZW03NuGFZYbRaGNYOb3jOcDeH2hSXmq2tvY48r3D751PPJmcZwu9d+vzD//a9TCOu7Q4WwcDAk9EbSBtwqFpqSnveDWNQoAXf5sbYfqA+wDxdjmm//veoDFJpCxNAqXKYodLpVmd0wrLCa3tMsDLfjqrXXX/j0ULg9/ZzZ2TmF2xQtpf7WZvtk52676/7kjDHX3XiX+eL4zbJz2P8SentgrMF9GnA7HtxLz/tBLGqsAb4CLoWmMLaxHhnHPlxEHGk1Y5oWotJMqkJneq5lGH7BH4bbdbcfTjMPP7rQenstzK6+znb2+BfGbWYuvfIGe/wvC55qeG3tJX7g4cftOc0yu489wv6X0BvYKg7uJQN8DGUVnwmdtn/6AIbQtv/IhaYIuYjYC6/+/a1JdDU2fCp06rjC8NtNwvDM0y62x4Ubhrsx/b55W83mMtM7WBJ6u7DqhaYY4GMIYwzw832gSD+g/WNI8x90+tpraLUPl4CLiLHdepeDzX/+M1SIatNthgpR/e7aNsPw/sdk9yCOpITeAlZt9koywMeQxhjgd/NMaNv+pee9IBY13/571QcoNIWIZVOFqO67/zEbXsWFlw0VouokDOed8M0dzJY7HWRfK3XTbX7M7OwIuPa3djUXXz7PzJl3u/332XmvI7zXVV1CbxOjDO7HdD57JRngY0hjDfDVD9QH2IeLMY21kiddpkzARcQye8ChJyXR1Zg33nzLrLXRLvZ4PgxfdNl12T1b7dw8DLuuud6O5plnX7TXuXzy6afmnPOv9t6DnXvk8Wcmv+E6d979oPe6qkvorRlr9qqbwb1kgI+hjL5Un4CLkdXfAbV/Ck0hIrZWjwh6ftHLSUQy5tiTzs3OdRKG8049fKiyc5433vynGf+NetGqVqpY1q77/Dxz8g5Tvde5dnJPGVV1a83Wpu9Ds+TNZtTlsSefm/x269x1D6G3L4w5e0WhKSyLMQb4+ZUMvnbezLT90wcwhLb9U2gKEbEjZ8y6KIlHxj46SCFLxzsJwz6vv+nu5EpjPvnkk6w6dMoeU47y3ueqoOeiis2+61y33PHA5Oo6qv7su67s6jFN+r2lqFL2yqt/33utPOKY05Ir6+jRTr7rqm5fh14KTSHW2lSEAX6+DxTpB7b9S897QSxq/oNOX3sNLYWmELFf/eakPcw/337HhiMVotr7x0OFqNww/NQzi5qH4ZOHwnDeCetub0Nxyp/+/KjZYocDzccf15dFi0tmX++911VLqV0efPhx73Wu+j4uD/3lSe91ZXejTfc2//73f5J3YczfnnupZejVcnJV1NbS8TPPu6qyM9zD2Veht2qDe0nAxZDGGOBTaArLYr7996oPaBZ39EoT2YeLiH3vlXP+kEQpY+744wPZstlWYXj6qf4w7FOPNnJRGNPx5xYtTo4Ys+jFJcM+5mjQQ+9HH/07eRfDh95BsbKht2qDe8kAH0Maa4DfzVJ92j+GMnahKfbhIuKgqWrKaSGqD2uhStWU03NuGFYhpDQMrztp94YwvM8Bx2b3+Lz8qhvtteLTT/9rttnlEHv8it/dlBytH9fy5fy9rvrZXO5/6K/e61w32Wq/5Oo67QTlvJrVXmujXe2HAPpffe27rqh6nXW+s7tdFq790b5rUr/x7d0aQu/Tf3vBe10ZXO3rW5mJG+5s24l+7tXX2a7l/uNurETojRFwpQb3Crjsw8XYVnGpftr+6QMYQv0diL0P1/dHFBFxENSjgrTUOOXiK+Zl5xSG0+W0CsObbXtAdq5ZGPapGeAXF7+aXG3M4pdfM6tN3NqemzL1+ORonTPOnb3M/QqGJ8w4z5z929+Zm269N7myjpZMz7765gZ33Wea+dKaW5jjp59nzjrvKnPjLfl7/rnMPXvue/Qy31fLg3/5q/PNnx9cYF557Q3zzrtLzdKlH9j/1dcP1MLzKWdcaoNd/l457bgzstc/+oSzsuNfWWtrc+i0U+zvTa/z3tL37f7mBU/8zfz0yF83vMbYNSbbe7U8+dp5d9hK1yn/euc9++/gvo/9D/lldq8+IHDPaY9vem6/g080s68ZOnfYUadm53yuMmGyOfM3V2bX6/u67UHqd673pUdWvVT799Z70u/r3feWmtffeMu+v/Mv+f0y93Vr6UJvFWevJAEXQxpjgE/AxbIY44NOCk0hIjZXISlFYVCzmDreMgzveGDTMOxzu90OtbO4KXpubHpOs4FuQavHn3x2mRlPza66BZyG4+RfX2j3ELv7hYfj12de1vA9tSRay63bQYHuB/stG5pVLTllwePP2GM/PuQkuyy5FUc5AVkzpAq37eLui973oBOTo3VuuWN+dm6v/Y9JjtZ5ecnfWy4tz8+wa8ZZ/y7pec1Uz39gQXK2NXqslT6QcF+/G6OGXs1e2cF9bWBTlcG9ZICPIY0xwM/3gSL9wLZ/6XkviEWN0f5VaEohVwGXfbiIiK3VjKO7p/a46b/JznUShpupGVoXPbrIPX/v/L8kZ4xdZr3xlvs2nFe4cgs4DcdJp5xvw6K7FHg4NGObfj/N8Gqm0oeCtBvgU7TUe72N92z4uW+5/b7krDFLXnndzL3hzuSr1ix59fVs+bQe45QuI2+Hiy8f+vf40U+OS47Wuf7mu7Nzmn13Q7275NynPkhwueEP92TntK9Ys9Y+9GGFOzudoiXxu//oyIbv0ak9Db1lmL3qaAZLet4PYlGjBNwunwlN+8dQ5tt/r/oAhaYQETvXDTJPPfOC3Yep4wrDzz4/FIbdWTkti01xw3AzFYiefOr55A5jl7vmlwOfOPO3ydk6+to9r4CmAKfv7VaSFvo5ddxVj/bRctz0HrfgllDF6fw93/7+D7Pvl/8eH3zwoTnt7CvMtrseagP597f/iV2GrNlRFzc4Szf0uig4a1ZUxbz0OtrX7AZpBcLNt6vPnut9aFZWP+MxvzynYfb61dfetI+Mct/Hptvsn33/VqFXnnvB1cmZOlpC7Z5P1dJ17YN20Wun57Wc3EU//1VzbjG77H2E3U+tn0nXP/LYwuSKOloG7X6fTh2x0BtrcE/AxbIYa4CvgEuhKYxtrJU87MNFRAyngudb//yXDR8KKT90QsxJp1xgj4t2w3Azv7f1/g1BTeEpv/9Xy6Pd5cvaQ9tsj7CudWmnkNV3t5hi32NKq0JWmsnWUmQXhWbftVMPm55cUUdVr93z+dCrWWzNkGqvtHud3qv76Cexw56HN1wjVfCqSCGr4UKvHmHk/t6fWPictxr0+pv8wAb/FIXtcWtvm513i5EJ7bt270+dNHmKXQ6fotlv33VFDRJ6YwRc2c3slWSAj6Gs4lL9tP3TBzCEtv1HLjRFyEVEDKuKEaVo72kaMhWs2gnDClxpGG6le4/Q177rFK5T3n//Q7PedxuXCqd28sgi7Ud1l9i2emSR3WPs7KFVSNtw07291+YfhZT/WfKh98jjz2w47/rQI08kV9Xxhd6ijywaLvRq77SKS6UolGtm1r1G/uwXs5Ir6lx65Q3ZObWbx/76dHKmzr4HntBwf6qWar/5j7eTq4wt4OW7rqiFQ2/M2Sv24WJZjDHAz/eBIv2A9o8hjfFBp/bhEnAREXunwlq6R1YhKl1KKxvC8L0PNQ3D7vLWZupeVTh2UTVkLYfN6+7rFc2qCY906NVSXPdaVVfWEmPftVqa7KLfl3s+H3r3mHJUw3lX/UwuvQi9UvufXfR1/prb7ro/OVvf+7v9Hodl5zT7rz3IKfrdfWfyjxruT1U7c39+zRj7ritqy9BLoSnEWpuKMMDvZqm+bf/S814Qixrrg04KTSEixlVBMcWdtdMzclO0JNkNw9fMvS05Y8wf7304C8OtzC+LLYJbadhVS3LbXaqcWiT0qtK0i/Ygz7vpj7YIlaseg+RWnRZ6pI/7WvnQ686a520n9Nrf54cfJVeECb0K0u5rarm4+2/7tfV3aiikpe+pRxOl51X0K/0wRCgUa69u/vel36EeVeVyz32PZK/TjQ2ht2qzV5IBPoY01gBf/UB9gH24GNNYz4NOlykTcBERy+OvTr/EnHfRtbaq8tc32Ck7rv2yv734Wnsu/7xYPUZHx8+7aI759uZDRZ9aqefCdoqClAJX/jVVRGokQ++OtbDZCQrACpDua4UOvaoO7X6IECL0SoXPFL2+W4U6/9gjFfRy780/cqoIe//4mIbX6tRR6eDGNxAJbbeFpiQDfAxlrAF+NysZaP8Y0hgreSg0hYiIrprxc1FY1UxgM/P49oaOdOhVhWYXfS/3++XRnl/taVVYzr9WVUJvfpm29vCm5+Zcd3tytL7nV4XJ3HvzM72i1e9LKwgWvbCk6fL1ThzlG5SEUoP7TqvISgb4GNIYA/wQAZc+gCGMsZKHQlOIiNhKzSC/7cwAqmiR9u5qNrmZ+ef5akl1/nVHOvSqkJNb0Vghc6/9fmG23PHAZdTeaD0eqVnwrEro1Wyt+2+VPkoov1/34UcX2urW7r0qZpZ/dJMereT7fUlV0l5t4tYNr9GtwUJvN4N7yQAfQ5pfpuxrs6HN94Ei/cC2f+l5L4hFjdH+KTSFiIhF3f+QXyYRqI4eQ+S7zlXPwHUfb6TA9dW1t2m4Jh96VSjLPe8z/7qtQm9+5lLfyy3cVMRehN58CHVtN/TK62+6O7mqvrRcv3e9b/d3rTCbv0/7fxWGXVSsLH/dSNpR6A0ScKVnsIZY1CgBd/mxth+oDxRdyUD7x5Dm238vZ3FH19o++3AREbFTr513RxKB6syY5X/WrevYNSabZ559MbmjHjh32fuIhms0I+wuhdYsox6F416TV7OLbuhVReYJ627vvdZXcVqFu778tS2917cydOj95qQ97OOcUlRgSlW189elFgm9+xxwbHJVHS3XPv2c2clX9YJezR4jdf4lv0+uqvPi4ldb/lyhHTb0djN7JRngY0hjDfDVDzpdqk/7x1DGLjTFPlxERAzluLW3tY+jSdHSYi1t9V2b9+Ir5iV31bng0rkN59edtHtD8BNPPvW8XQp91Zxb7BJphWf3nrU22tW8+97S5Oo6Tz2zKLvnNxde01CReNpxZyRXDfHogqftM4Z/8tOT7Sz21MOmm58fc7qZfupFNvTpdSZ8c4eG7xs69Crcv/7GW8kVdZ5btNjuu9X3v/CyuQ0z40VCr+5zlzLPmXe7+euTQ8/wveOPD3jvk1vudFDD8nHxUi34nnHubHPg4TPs7+uAQ08yhx89y84Cn3vB1fZDET0eyvd6RW0IvW6hKfbhYmyrXGiKPoAh1Ic8sffh+v5wICIidutuP5yWRJ86i15c0vZM6V77H5PcVUdLeN0Qu/L4zRseuZRHhaUUct3X1BLg++5/LLliWTQL7M5Mas/pXxY8lZxtH81Cu983H3qnTD2+4bxrO6FX3nzrn5Ir/EyaPCW7tkjolfkPHFymHj7de0+q+3zndlEI9r1WUUeFKDTFAB9DGGOA381KBto/hjTGMn0KTSEiYiyvnPOHJNbU+d21t3qv86k9tflZWVVUdq/R0tv8bK+LZh7d66Wev6tiWs3Qefd6zSi3Cso+VKjLfY277nkwOVNHs8PueVd3VlXsvFfjsu5UzY7mqyW76EOD9Nr844aaPfs4NV+5OuXNf7xt1sjNYudVQSvNNvuqcDdDs+S+1yrqKN9g3icDfAxpjAF+N4/Msu1fet4LYlFjtH8VmlLIVcBlHy4iIsZUe2JPOuV8O2uYutXOB3uvbeaxJ5+b3XvJ7Ou9s54KaJr1fOGlV+yy3GefX2zmP7DAXHrlDQ3PmXXVz3HjLffamef0HhXYuuyqG80G39trmetXmTDZzs5q+fDjTz5r71EgV+jU8l0dU5A89azLbNEnd4m01KN/3N9DfibY9fjp5zVcu2Humb+uCr5zb7jTPvpHP5OWOGsf8uxrbrZFu9Lr9Hgh9zXzz17Oqxnx/M980WXXLbOvupX6PVx8+TzzyGMLzeKXX7PP8JVLXnndLinX/mg961nP6B1uL3a7ekMvA3wMaYwBvtQsbqdL9Wn/GMp8++/lLC6FphARERFroZeAiyGNNcDPlikTcDGi2oeuPqD2zz5cRERExHI4yjdwQ2zHWAN8Ck1hWbTtP3KhKUIuIiIiYmsJvdi2MQb4FJrCsphfxeBrr6HVPlwCLiIiImJ3EnrRa4wBPoWmsCzm238vZ3EpNIWIiIgYVkIvRhvgaxa300dmEXAxlLGeB50uUybgIiIiIo6shN4BM9YAP8Q+XN/7QSyqXaZfa4sUmkJEREQcDAm9fW6MAT6FprAs2vZPoSlERETEgZbQ20fmlyn7BuSh7brQlPS8F8Sixmj/FJpCRERELL+E3ooaJeAuP9aGXAXcovtwCbgY0nz77+Us7uha22cfLiIiImJ1JPRWwFgDfApNYRmMXWiKfbiIiIiI1ZbQWzI1wFfI1QCffbg4iNr2H3kfru8/loiIiIhYTQm9kY0xwO96H27t5ybgYgjzqxh87TW0FJpCREREHCwJvT00xgBf+3ApNIVlMEb7V6EphVwFXPbhIiIiIg6mhN4RMj/A7+UsbieFpiQBF0MZq/1TaAoRERER8xJ6Axir0E6Ifbi+94NYxFj70NmHi4iIiIjtSOjtwBgDfApNYVm07T9yoSlCLiIiIiK2K6F3GLNlmj0c4FNoCstifpmyr72GVvtwCbiIiIiIGEpCr2OMAb5baKroPlwbcKXnvSAWNd/+ezmLS6EpRERERBwpBzb0xhrgaxZ3uRXGUWgKoxprH3q6TJmAi4iIiIi9ciBCL4WmcNDVhzxq/xSaQkRERMRBsy9Drx3g97jQDoWmsCxmqxjGxAu4hFxERERELIuVD735Zcq+AXlo3X24Crjsw8VYxmj/FJpCRERExCpZqdAbK+BqFpdCUxjbfPvv5Szu6FrbZx8uIiIiIlbR0obeWAN8Ck1hGYy1D32LrXc2B0w9zFx51TVm8eIlBgAAAACg6pQi9GqAr5CrAT77cHEQte2/x/vQCbgAAAAAMAhECb0xBvj5gFt4mXLt5ybgYgjzqxh87TW0+YBLyAUAAACAQWHEQ2+MAT6FprAsxmj/a07cwIZcBdz75j9AwAUAAACAgSZo6M0P8Hs5i9tJoSlJwMVQxmr/CrgzZs4i4AIAAAAAeOg49MYqtBNiH67v/SAWMdY+dPbhAgAAAAAUo+3QG2OAT6EpLIu2/UcuNEXIBQAAAAAojjf05pdp+gbkoaXQFJbFGO1f+3AJuAAAAAAA4RkVJeAuP7bjfbg24EpPWEEsar7993IWl0JTAAAAAAAjzyjfgDy0CrjLrTCOQlMY1Vj70NNlygRcAAAAAIDeEzz0UmgKy6Ldh1trixSaAgAAAAAYXLoKvezDxbKYLVMeQ6EpAAAAAAAYou3Qq324XQVc6QkriEWl0BQAAAAAALRL09BLoSksgzELTc2YOYt9uAAAAAAAFceG3myZMoWmMKKxC02xDxcAAAAAoP8Y5QuyzUwDLiEXQ2gLTa04nkJTAAAAAAAwYjQNvQRcDGmMfbgUmgIAAAAAABt62YeLIY1VaEohVwGXfbgAAAAAAJAyyhdaENuVQlMAAAAAAFBmCL3Ytio0Zffh1gIu+3ABAAAAAKAKEHqxqWUoNEXIBQAAAACAbiD0ojXWPlwCLgAAAAAAjCSE3gE05j5cCk0BAAAAAEAvIfT2udqHGyvgahaXgAsAAAAAADEh9PaZFJoCAAAAAAAYgtBbYbNlyhSaAgAAAAAA8ELorYgUmgIAAAAAACgOobeExiw0NWPmLPbhAgAAAABA30DojWzsQlPswwUAAAAAgH6G0NtjbaGpFcdTaAoAAAAAAKAHEHpH0Bj7cCk0BQAAAAAAMAShN5CxCk0p5Crgsg8XAAAAAABgWQi9HUihKQAAAAAAgGpA6B1GFZqy+3BrAZd9uAAAAAAAANWC0JuzDIWmCLkAAAAAAABhGOjQG2sfLgEXAAAAAACgNwxM6I25D5dCUwAAAAAAAHHoy9CrfbixAq5mcQm4AAAAAAAA5aAvQi+FpgAAAAAAAMBH5UJvtkyZQlMAAAAAAAAwDKUOvRSaAgAAAAAAgG4oTeiNWWhqxsxZ7MMFAAAAAADoQ6KE3tiFptiHCwAAAAAAMBj0JPTaQlMrjqfQFAAAAAAAAPSU4KE3xj5cCk0BAAAAAACAj65Cb6xCUwq5CrjswwUAAAAAAIBWtB16KTQFAAAAAAAAVcMbelVoyu7DrQVc9uECAAAAAABAVbGhtwyFpgi5AAAAAAAAEJpRvkAaWu3DJeACAAAAAABArxmR0EuhKQAAAAAAACgDXYfedJkyARcAAAAAAADKRqHQS6EpAAAAAAAAqBJNQy+FpgAAAAAAAKDq2NBLoSkAAAAAAADoR0bNnTsv+b8AAAAAAAAA/cWo+fPnJ/8XAAAAAAAAoL8g9AIAAAAAAEDfQugFAAAAAACAPsWY/wdjR7FYPuFt/AAAAABJRU5ErkJggg=='
export const RODAPE = 'Endereço: Av. Paulista, 1274 – Conj. 33, 13º andar - Bela Vista, São Paulo - SP, 01310-100 · Site: attentivecontabilidade.com.br'

// abrePdfTimbrado({ titulo, sub, colunas, linhas, totais })
// - colunas: [{ nome, alinhar?: 'right' }]
// - linhas: array de arrays (células já formatadas em string)
// - totais: array de células (string) para o rodapé da tabela (opcional)
// abrePdfTimbrado({ titulo, sub, colunas, linhas?, totais?, secoes? })
// - secoes: [{ titulo, linhas, totais }] → relatório em blocos (ex.: por cliente).
export function abrePdfTimbrado({ titulo, sub = '', colunas, linhas, totais, secoes }) {
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const n = colunas.length
  const th = colunas.map(c => `<th class="${c.alinhar === 'right' ? 'r' : ''}">${esc(c.nome)}</th>`).join('')
  const tr = row => `<tr>${row.map((cel, i) => `<td class="${colunas[i]?.alinhar === 'right' ? 'r' : ''}">${esc(cel)}</td>`).join('')}</tr>`
  const subtotalRow = (rotulo, tot) => `<tr class="sub">${tot.map((cel, i) => `<td class="${colunas[i]?.alinhar === 'right' ? 'r' : ''}">${i === 0 ? esc(rotulo) : esc(cel)}</td>`).join('')}</tr>`

  let corpo
  if (secoes) {
    corpo = secoes.map(sec => {
      const grp = `<tr class="grp"><td colspan="${n}">${esc(sec.titulo)}</td></tr>`
      const ls = sec.linhas.map(tr).join('')
      const sub = sec.totais ? subtotalRow('Subtotal', sec.totais) : ''
      return grp + ls + sub
    }).join('') || `<tr><td colspan="${n}">Sem lançamentos.</td></tr>`
  } else {
    corpo = (linhas || []).map(tr).join('') || `<tr><td colspan="${n}">Sem lançamentos.</td></tr>`
  }
  const tfoot = totais ? `<tfoot><tr>${totais.map((cel, i) => `<td class="${colunas[i]?.alinhar === 'right' ? 'r' : ''}">${esc(cel)}</td>`).join('')}</tr></tfoot>` : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(titulo)}</title>
    <style>
      @page { margin: 96px 28px 64px; }
      body { font-family: Arial, Helvetica, sans-serif; color:#111; margin:0; }
      .hdr { position: fixed; top:0; left:0; right:0; height:70px; }
      .hdr img { width:100%; height:70px; object-fit:cover; display:block; }
      .ftr { position: fixed; bottom:0; left:0; right:0; text-align:center; color:#555; font-size:9px; padding:8px 24px; border-top:1px solid #e3e3e3; }
      h2 { font-size:15px; margin:0 0 2px; color:#1b2a4a; }
      p.sub { color:#555; font-size:11px; margin:0 0 14px; }
      table { width:100%; border-collapse:collapse; font-size:10.5px; }
      th,td { border:1px solid #ccc; padding:5px 7px; text-align:left; vertical-align:top; }
      th { background:#1b2a4a; color:#fff; }
      .r { text-align:right; white-space:nowrap; }
      tr.grp td { background:#dfe6f3; color:#1b2a4a; font-weight:bold; font-size:11px; }
      tr.sub td { background:#f2f2f2; font-weight:bold; }
      tfoot td { font-weight:bold; background:#e9edf5; }
      thead { display: table-header-group; }
    </style></head>
    <body>
      <div class="hdr"><img src="${HEADER_IMG}" /></div>
      <div class="ftr">${esc(RODAPE)}</div>
      <h2>${esc(titulo)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
      <table><thead><tr>${th}</tr></thead><tbody>${corpo}</tbody>${tfoot}</table>
      <script>window.onload=function(){setTimeout(function(){window.print()},250)}</script>
    </body></html>`
  const w = window.open('', '_blank')
  if (!w) { alert('Permita pop-ups para gerar o PDF.'); return }
  w.document.write(html); w.document.close()
}

// ---------------------------------------------------------------------------
// DRE no PADRÃO DOMÍNIO: cabeçalho Empresa/CNPJ/Período, título "DEMONSTRAÇÃO DO
// RESULTADO DO EXERCÍCIO EM ...", colunas Descrição · Saldo · Total. Componentes com
// valor em Saldo e Total; subtotais (negrito) só na coluna Total. Negativos em parênteses.
// rows: [{ label, valor, sub }] (de montarDRE).
export function abreDreDominio({ empresa = '', cnpj = '', periodoIni = '', periodoFim = '', dataFim = '', rows = [] }) {
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const fmtP = v => { const n = Number(v) || 0; const a = Math.abs(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < -0.005 ? `(${a})` : a }

  const corpo = (rows || []).map(r => r.sub
    ? `<tr class="sub"><td class="desc">${esc(r.label)}</td><td class="r"></td><td class="r">${fmtP(r.valor)}</td></tr>`
    : `<tr><td class="desc">${esc(r.label)}</td><td class="r">${fmtP(r.valor)}</td><td class="r">${fmtP(r.valor)}</td></tr>`
  ).join('') || `<tr><td colspan="3">Sem dados de resultado.</td></tr>`

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>DRE - ${esc(empresa)}</title>
    <style>
      @page { margin: 22px 24px 30px; }
      * { box-sizing: border-box; }
      body { font-family: Arial, Helvetica, sans-serif; color:#000; margin:0; font-size:10px; }
      .cab { border:1px solid #000; margin-bottom:6px; }
      .cab table { width:100%; border-collapse:collapse; }
      .cab td { padding:3px 8px; font-size:10px; }
      .cab .lab { font-weight:bold; width:70px; }
      .cab .folha { text-align:right; white-space:nowrap; }
      .cab .row2 td { border-top:1px solid #000; }
      h1 { text-align:center; font-size:12px; margin:8px 0 8px; }
      table.dre { width:100%; border-collapse:collapse; }
      table.dre thead th { border-top:1px solid #000; border-bottom:1px solid #000; padding:4px 6px; font-size:9.5px; background:#eee; text-align:left; }
      table.dre thead th.r { text-align:right; width:150px; }
      table.dre td { padding:5.5px 6px; vertical-align:top; font-variant-numeric: tabular-nums; line-height:1.35; }
      table.dre td.r { text-align:right; white-space:nowrap; }
      table.dre td.desc { }
      table.dre tr.sub td { font-weight:bold; border-top:1px solid #999; border-bottom:1px solid #999; background:#f4f4f4; }
      thead { display: table-header-group; }
    </style></head>
    <body>
      <div class="cab"><table>
        <tr><td class="lab">Empresa:</td><td>${esc(empresa)}</td><td class="folha">Folha:&nbsp;&nbsp;0001</td></tr>
        <tr class="row2"><td class="lab">C.N.P.J.:</td><td>${esc(cnpj)}</td><td class="folha">&nbsp;</td></tr>
        <tr class="row2"><td class="lab">Período:</td><td>${esc(periodoIni)} - ${esc(periodoFim)}</td><td class="folha">&nbsp;</td></tr>
      </table></div>
      <h1>DEMONSTRAÇÃO DO RESULTADO DO EXERCÍCIO EM ${esc(dataFim || periodoFim)}</h1>
      <table class="dre">
        <thead><tr><th>Descrição</th><th class="r">Saldo</th><th class="r">Total</th></tr></thead>
        <tbody>${corpo}</tbody>
      </table>
      <script>window.onload=function(){setTimeout(function(){window.print()},250)}</script>
    </body></html>`
  const w = window.open('', '_blank')
  if (!w) { alert('Permita pop-ups para gerar o PDF.'); return }
  w.document.write(html); w.document.close()
}

// ---------------------------------------------------------------------------
// Balancete no PADRÃO DOMÍNIO (mesma cara do relatório que o Domínio emite):
// cabeçalho Empresa / C.N.P.J. / Período / Folha, título BALANCETE e as colunas
// Código · Classificação · Descrição da conta · Saldo Anterior · Débito · Crédito
// · Saldo Atual, com o sufixo D/C nos saldos e a hierarquia (sintéticas + analíticas).
// linhas: [{ reduzido, classif, nome, saldo_inicial, debito, credito, saldo_final, sintetica }]
export function abreBalanceteDominio({ empresa = '', cnpj = '', periodoIni = '', periodoFim = '', linhas = [], resumo = null }) {
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const fmt = v => Math.abs(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const dc = v => { const n = Number(v) || 0; return Math.abs(n) < 0.005 ? '0,00' : fmt(n) + (n >= 0 ? 'D' : 'C') }

  // Bloco RESUMO DO BALANCETE (grupos + contas devedoras/credoras + resultado).
  const linhaRes = (r, cls = '') => `<tr class="${cls}"><td class="desc">${esc(r.label)}</td><td class="r">${dc(r.ini)}</td><td class="r">${fmt(r.deb)}</td><td class="r">${fmt(r.cred)}</td><td class="r">${dc(r.fim)}</td></tr>`
  const blocoResumo = resumo ? `
    <h1 style="margin-top:22px">RESUMO DO BALANCETE</h1>
    <table class="bal resumo">
      <tbody>
        ${resumo.grupos.map(g => linhaRes(g)).join('')}
        <tr class="gap"><td colspan="5">&nbsp;</td></tr>
        ${linhaRes(resumo.devedoras, 'sint')}
        ${linhaRes(resumo.credoras, 'sint')}
        <tr class="gap"><td colspan="5">&nbsp;</td></tr>
        ${linhaRes(resumo.resultadoMes, 'sint')}
        ${linhaRes(resumo.resultadoExerc, 'sint')}
      </tbody>
    </table>` : ''

  const corpo = (linhas || []).map(l => {
    const sint = !!l.sintetica
    return `<tr class="${sint ? 'sint' : ''}">
      <td class="cod">${esc(l.reduzido || '')}</td>
      <td class="cla">${esc(l.classif || '')}</td>
      <td class="desc">${esc(l.nome || '')}</td>
      <td class="r">${dc(l.saldo_inicial)}</td>
      <td class="r">${fmt(l.debito)}</td>
      <td class="r">${fmt(l.credito)}</td>
      <td class="r">${dc(l.saldo_final)}</td>
    </tr>`
  }).join('') || `<tr><td colspan="7">Sem dados no balancete.</td></tr>`

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Balancete - ${esc(empresa)}</title>
    <style>
      @page { margin: 22px 24px 30px; }
      * { box-sizing: border-box; }
      body { font-family: Arial, Helvetica, sans-serif; color:#000; margin:0; font-size:9.2px; }
      .cab { border:1px solid #000; padding:0; margin-bottom:6px; }
      .cab table { width:100%; border-collapse:collapse; }
      .cab td { padding:3px 8px; border:none; font-size:10px; }
      .cab .lab { color:#000; font-weight:bold; width:70px; }
      .cab .folha { text-align:right; white-space:nowrap; }
      .cab .row2 td { border-top:1px solid #000; }
      h1 { text-align:center; font-size:13px; letter-spacing:2px; margin:10px 0 8px; }
      table.bal { width:100%; border-collapse:collapse; }
      table.bal thead th { border-top:1px solid #000; border-bottom:1px solid #000; padding:6px; font-size:9px; text-align:left; background:#eee; }
      table.bal thead th.r { text-align:right; }
      table.bal td { padding:4.5px 6px; vertical-align:top; font-variant-numeric: tabular-nums; line-height:1.35; }
      table.bal td.r { text-align:right; white-space:nowrap; }
      table.bal td.cod { width:52px; color:#000; }
      table.bal td.cla { width:110px; white-space:nowrap; }
      table.bal td.desc { }
      table.bal tr.sint td { font-weight:bold; border-top:1px solid #bbb; }
      table.resumo td { padding:6px; }
      table.resumo tr.gap td { padding:0; height:8px; border:none; }
      table.resumo tr.sint td { border-top:1px solid #999; }
      thead { display: table-header-group; }
      tr { page-break-inside: avoid; }
    </style></head>
    <body>
      <div class="cab"><table>
        <tr>
          <td class="lab">Empresa:</td><td>${esc(empresa)}</td><td class="folha">Folha:&nbsp;&nbsp;0001</td>
        </tr>
        <tr class="row2">
          <td class="lab">C.N.P.J.:</td><td>${esc(cnpj)}</td><td class="folha">&nbsp;</td>
        </tr>
        <tr class="row2">
          <td class="lab">Período:</td><td>${esc(periodoIni)} - ${esc(periodoFim)}</td><td class="folha">&nbsp;</td>
        </tr>
      </table></div>
      <h1>BALANCETE</h1>
      <table class="bal">
        <thead><tr>
          <th>Código</th><th>Classificação</th><th>Descrição da conta</th>
          <th class="r">Saldo Anterior</th><th class="r">Débito</th><th class="r">Crédito</th><th class="r">Saldo Atual</th>
        </tr></thead>
        <tbody>${corpo}</tbody>
      </table>
      ${blocoResumo}
      <script>window.onload=function(){setTimeout(function(){window.print()},250)}</script>
    </body></html>`
  const w = window.open('', '_blank')
  if (!w) { alert('Permita pop-ups para gerar o PDF.'); return }
  w.document.write(html); w.document.close()
}
